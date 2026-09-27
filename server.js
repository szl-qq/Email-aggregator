/**
 * 邮箱聚合助手（轻量稳定版）
 * 单进程 Node 服务：Express + JSON 文件存储，无数据库、无构建、无系统依赖
 * 协议：IMAP / POP3 / SMTP（Exchange 走 IMAP 端点提示）
 * 启动：node server.js  （默认端口 3000）
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

/* ==================== 配置 ==================== */
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

// AES-256-GCM 加密密钥（本地工具，固定默认；可用环境变量 EMAIL_KEY 覆盖）
const ENCRYPTION_KEY = Buffer.from(
  process.env.EMAIL_KEY || 'a1b2c3d4e5f607182930a1b2c3d4e5f6a1b2c3d4e5f607182930a1b2c3d4e5f6',
  'hex',
);

/* ==================== 存储层（JSON 文件） ==================== */
function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, '[]', 'utf8');
}
function readAccounts() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch { return []; }
}
function writeAccounts(list) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2), 'utf8');
}
function readMessages(accountId) {
  const f = path.join(MESSAGES_DIR, `${accountId}.json`);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}
function writeMessages(accountId, messages) {
  fs.writeFileSync(path.join(MESSAGES_DIR, `${accountId}.json`), JSON.stringify(messages, null, 2), 'utf8');
}

/* ==================== 加密 ==================== */
function encryptPassword(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptPassword(encStr) {
  const buf = Buffer.from(encStr, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf8');
}

/* ==================== 账号对象工具 ==================== */
function toPublicAccount(a) {
  const msgs = readMessages(a.id);
  const unreadCount = msgs.filter((m) => !m.isRead).length;
  return {
    id: a.id,
    name: a.name,
    emailAddress: a.emailAddress,
    provider: a.provider,
    protocol: a.protocol,
    imapHost: a.imapHost, imapPort: a.imapPort, imapSecure: a.imapSecure,
    pop3Host: a.pop3Host, pop3Port: a.pop3Port, pop3Secure: a.pop3Secure,
    smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSecure: a.smtpSecure,
    exchangeServerUrl: a.exchangeServerUrl,
    username: a.username,
    status: a.status,
    lastSyncAt: a.lastSyncAt || null,
    unreadCount,
  };
}
function accountFromBody(body) {
  const protocol = body.protocol || 'imap';
  return {
    id: randomUUID(),
    name: (body.name || '').trim() || body.emailAddress || '邮箱',
    emailAddress: (body.emailAddress || '').trim(),
    provider: body.provider || 'custom',
    protocol,
    imapHost: body.imapHost || '', imapPort: Number(body.imapPort) || 993, imapSecure: body.imapSecure !== false,
    pop3Host: body.pop3Host || '', pop3Port: Number(body.pop3Port) || 995, pop3Secure: body.pop3Secure !== false,
    smtpHost: body.smtpHost || '', smtpPort: Number(body.smtpPort) || 465, smtpSecure: body.smtpSecure !== false,
    exchangeServerUrl: body.exchangeServerUrl || '',
    username: (body.username || '').trim(),
    passwordEncrypted: body.password ? encryptPassword(body.password) : '',
    status: 'offline',
    lastSyncAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/* ==================== 协议连接 ==================== */
function accountToConn(acc, password) {
  return {
    protocol: acc.protocol,
    imap: { host: acc.imapHost, port: acc.imapPort, secure: acc.imapSecure },
    pop3: { host: acc.pop3Host, port: acc.pop3Port, secure: acc.pop3Secure },
    smtp: { host: acc.smtpHost, port: acc.smtpPort, secure: acc.smtpSecure },
    auth: { user: acc.username || acc.emailAddress, pass: password },
  };
}

/** IMAP：连接测试 */
async function imapTest(conn) {
  const client = new ImapFlow({
    host: conn.imap.host, port: conn.imap.port, secure: conn.imap.secure,
    auth: conn.auth, logger: false, timeout: 20000,
  });
  await client.connect();
  await client.noop();
  await client.logout();
  return true;
}
/** IMAP：拉取 INBOX 邮件 */
async function imapFetch(conn, limit = 50) {
  const client = new ImapFlow({
    host: conn.imap.host, port: conn.imap.port, secure: conn.imap.secure,
    auth: conn.auth, logger: false, timeout: 30000,
  });
  const out = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true });
      const total = status.messages || 0;
      const count = Math.min(total, limit);
      if (count > 0) {
        const startSeq = Math.max(1, total - count + 1);
        for await (const msg of client.fetch(`${startSeq}:${total}`, {
          uid: true, envelope: true, flags: true, source: true,
        })) {
          try {
            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value?.[0];
            const toList = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to])
              .flatMap((a) => a.value?.map((v) => v.address || '') || []).filter(Boolean) : [];
            const ccList = parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc])
              .flatMap((a) => a.value?.map((v) => v.address || '') || []).filter(Boolean) : [];
            out.push({
              messageUid: String(msg.uid),
              subject: parsed.subject || '(无主题)',
              senderName: from?.name || undefined,
              senderEmail: from?.address || '',
              recipients: toList.join(', '),
              cc: ccList.length ? ccList.join(', ') : undefined,
              dateReceived: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
              bodyText: parsed.text || undefined,
              bodyHtml: parsed.html || undefined,
              isRead: msg.flags?.has('\\Seen') ?? false,
              isStarred: msg.flags?.has('\\Flagged') ?? false,
              folder: 'INBOX',
              hasAttachment: !!(parsed.attachments && parsed.attachments.length),
            });
          } catch { /* 跳过解析失败的单封邮件 */ }
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout(); }
  return out;
}

/** POP3：连接测试 */
function pop3Test(conn) {
  return new Promise((resolve, reject) => {
    const POP3Client = require('poplib');
    const client = new POP3Client(conn.pop3.host, conn.pop3.port, {
      enabletlstls: conn.pop3.secure ? 'yes' : false,
      debug: false,
    });
    const fail = (label, err) => { try { client.quit(); } catch {} reject(new Error(`${label}: ${err?.message || err}`)); };
    client.on('connect', () => {
      client.login(conn.auth.user, conn.auth.pass);
    });
    client.on('login', (status) => {
      if (status) { try { client.quit(); } catch {} resolve(true); }
      else fail('登录失败');
    });
    client.on('error', (err) => fail('连接失败', err));
    client.on('invalid-state', (err) => fail('状态异常', err));
    client.on('timeout', () => fail('连接超时'));
    client.on('connect-error', (err) => fail('无法连接', err));
  });
}

/** SMTP：连接测试（nodemailer verify） */
async function smtpTest(conn) {
  const transporter = nodemailer.createTransport({
    host: conn.smtp.host, port: conn.smtp.port,
    secure: conn.smtp.secure,
    auth: { user: conn.auth.user, pass: conn.auth.pass },
    connectionTimeout: 20000, greetingTimeout: 20000,
  });
  await transporter.verify();
  return true;
}

/** 统一测试连接入口 */
async function testConnectionByAccount(acc, password) {
  const conn = accountToConn(acc, password);
  switch (acc.protocol) {
    case 'imap': return imapTest(conn);
    case 'pop3': return pop3Test(conn);
    case 'smtp': return smtpTest(conn);
    case 'exchange':
      throw new Error('Exchange 协议暂不支持直连，多数 Exchange 邮箱开放 IMAP，请改用 IMAP 协议（服务器地址填 Exchange 的 IMAP 端点）');
    default: throw new Error(`未知协议: ${acc.protocol}`);
  }
}

/** 统一拉取邮件入口（Exchange 暂不支持） */
async function fetchByAccount(acc, password, limit = 50) {
  const conn = accountToConn(acc, password);
  switch (acc.protocol) {
    case 'imap': return imapFetch(conn, limit);
    case 'pop3': {
      // POP3 拉取（简化：拉取头部，正文需逐封 RETR，这里拉最近 limit 封的头部）
      throw new Error('POP3 同步暂未实现，建议使用 IMAP（功能完整）');
    }
    default:
      throw new Error(`协议 ${acc.protocol} 暂不支持同步，建议使用 IMAP`);
  }
}

/* ==================== 同步逻辑 ==================== */
function upsertMessages(accountId, fetched) {
  const existing = readMessages(accountId);
  const seen = new Map(existing.map((m) => [`${m.folder}/${m.messageUid}`, m]));
  let newCount = 0;
  for (const m of fetched) {
    const key = `${m.folder}/${m.messageUid}`;
    const prev = seen.get(key);
    if (prev) {
      // 更新已读/星标状态与正文（保留本地用户操作过的标记，正文以服务器为准）
      Object.assign(prev, {
        subject: m.subject, senderName: m.senderName, senderEmail: m.senderEmail,
        recipients: m.recipients, cc: m.cc, dateReceived: m.dateReceived,
        bodyText: m.bodyText, bodyHtml: m.bodyHtml, hasAttachment: m.hasAttachment,
        isRead: prev.isRead ? true : m.isRead,
        isStarred: prev.isStarred ? true : m.isStarred,
      });
    } else {
      const newMsg = {
        id: randomUUID(), accountId, messageUid: m.messageUid,
        subject: m.subject, senderName: m.senderName, senderEmail: m.senderEmail,
        recipients: m.recipients, cc: m.cc, dateReceived: m.dateReceived,
        bodyText: m.bodyText, bodyHtml: m.bodyHtml,
        isRead: m.isRead, isStarred: m.isStarred,
        folder: m.folder, hasAttachment: m.hasAttachment,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      seen.set(key, newMsg);
      newCount++;
    }
  }
  const list = [...seen.values()];
  writeMessages(accountId, list);
  return { syncedCount: fetched.length, newCount };
}

/* ==================== Express 应用 ==================== */
const app = express();
app.use(express.json({ limit: '2mb' }));

// 前端静态资源
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 账号列表
app.get('/api/accounts', (req, res) => {
  const accounts = readAccounts().map(toPublicAccount);
  res.json({ items: accounts });
});

// 添加账号
app.post('/api/accounts', (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.emailAddress || !body.username || !body.password) {
      return res.status(400).json({ message: '邮箱地址、用户名、授权码均为必填' });
    }
    const acc = accountFromBody(body);
    const list = readAccounts();
    if (list.some((a) => a.emailAddress === acc.emailAddress)) {
      return res.status(400).json({ message: '该邮箱已添加，请勿重复添加' });
    }
    list.push(acc);
    writeAccounts(list);
    res.json(toPublicAccount(acc));
  } catch (e) { next(e); }
});

// 更新账号
app.patch('/api/accounts/:id', (req, res, next) => {
  try {
    const list = readAccounts();
    const idx = list.findIndex((a) => a.id === req.params.id);
    if (idx < 0) return res.status(404).json({ message: '账号不存在' });
    const a = list[idx];
    const b = req.body || {};
    if (b.name !== undefined) a.name = b.name;
    if (b.protocol !== undefined) a.protocol = b.protocol;
    if (b.imapHost !== undefined) a.imapHost = b.imapHost;
    if (b.imapPort !== undefined) a.imapPort = Number(b.imapPort);
    if (b.imapSecure !== undefined) a.imapSecure = !!b.imapSecure;
    if (b.pop3Host !== undefined) a.pop3Host = b.pop3Host;
    if (b.pop3Port !== undefined) a.pop3Port = Number(b.pop3Port);
    if (b.pop3Secure !== undefined) a.pop3Secure = !!b.pop3Secure;
    if (b.smtpHost !== undefined) a.smtpHost = b.smtpHost;
    if (b.smtpPort !== undefined) a.smtpPort = Number(b.smtpPort);
    if (b.smtpSecure !== undefined) a.smtpSecure = !!b.smtpSecure;
    if (b.exchangeServerUrl !== undefined) a.exchangeServerUrl = b.exchangeServerUrl;
    if (b.username !== undefined) a.username = b.username;
    if (b.password) a.passwordEncrypted = encryptPassword(b.password);
    a.updatedAt = new Date().toISOString();
    writeAccounts(list);
    res.json(toPublicAccount(a));
  } catch (e) { next(e); }
});

// 删除账号（连同邮件数据）
app.delete('/api/accounts/:id', (req, res, next) => {
  try {
    const list = readAccounts();
    const nextList = list.filter((a) => a.id !== req.params.id);
    if (nextList.length === list.length) return res.status(404).json({ message: '账号不存在' });
    writeAccounts(nextList);
    const f = path.join(MESSAGES_DIR, `${req.params.id}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// 测试连接（用表单提交的明文配置，不保存）
app.post('/api/accounts/test-connection', async (req, res, next) => {
  try {
    const body = req.body || {};
    const acc = {
      id: 'tmp', protocol: body.protocol || 'imap',
      imapHost: body.imapHost || '', imapPort: Number(body.imapPort) || 993, imapSecure: body.imapSecure !== false,
      pop3Host: body.pop3Host || '', pop3Port: Number(body.pop3Port) || 995, pop3Secure: body.pop3Secure !== false,
      smtpHost: body.smtpHost || '', smtpPort: Number(body.smtpPort) || 465, smtpSecure: body.smtpSecure !== false,
      exchangeServerUrl: body.exchangeServerUrl || '',
      username: body.username || body.emailAddress || '',
    };
    if (!acc.username || !body.password) {
      return res.status(400).json({ success: false, message: '请填写完整账号信息（用户名 + 授权码）' });
    }
    const ok = await testConnectionByAccount(acc, body.password);
    res.json({ success: ok, message: ok ? '连接成功，配置可用' : '连接失败，请检查配置' });
  } catch (e) {
    res.json({ success: false, message: `连接失败：${e.message}` });
  }
});

// 同步账号
app.post('/api/accounts/:id/sync', async (req, res, next) => {
  try {
    const list = readAccounts();
    const acc = list.find((a) => a.id === req.params.id);
    if (!acc) return res.status(404).json({ message: '账号不存在' });
    if (!acc.passwordEncrypted) return res.status(400).json({ message: '该账号未保存授权码，请编辑补全' });
    const password = decryptPassword(acc.passwordEncrypted);
    const fetched = await fetchByAccount(acc, password, Number(req.query.limit) || 50);
    const result = upsertMessages(acc.id, fetched);
    acc.status = 'online';
    acc.lastSyncAt = new Date().toISOString();
    acc.updatedAt = new Date().toISOString();
    writeAccounts(list);
    res.json({ accountId: acc.id, ...result, status: 'online' });
  } catch (e) {
    next(e);
  }
});

// 邮件列表
app.get('/api/messages', (req, res) => {
  const { accountId, folder, isRead, isStarred, keyword, page, pageSize } = req.query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));
  let all = [];
  if (accountId) {
    all = readMessages(accountId);
  } else {
    for (const f of fs.readdirSync(MESSAGES_DIR)) {
      if (f.endsWith('.json')) all = all.concat(readMessages(f.replace('.json', '')));
    }
  }
  if (folder) all = all.filter((m) => m.folder === folder);
  if (isRead === 'true') all = all.filter((m) => m.isRead);
  if (isRead === 'false') all = all.filter((m) => !m.isRead);
  if (isStarred === 'true') all = all.filter((m) => m.isStarred);
  if (isStarred === 'false') all = all.filter((m) => !m.isStarred);
  if (keyword) {
    const kw = keyword.toLowerCase();
    all = all.filter((m) =>
      (m.subject || '').toLowerCase().includes(kw) ||
      (m.senderName || '').toLowerCase().includes(kw) ||
      (m.senderEmail || '').toLowerCase().includes(kw) ||
      (m.bodyText || '').toLowerCase().includes(kw));
  }
  all.sort((a, b) => new Date(b.dateReceived) - new Date(a.dateReceived));
  const total = all.length;
  const items = all.slice((p - 1) * ps, p * ps).map((m) => ({
    id: m.id, accountId: m.accountId, messageUid: m.messageUid,
    subject: m.subject, senderName: m.senderName, senderEmail: m.senderEmail,
    recipients: m.recipients, cc: m.cc, dateReceived: m.dateReceived,
    isRead: m.isRead, isStarred: m.isStarred, folder: m.folder,
    hasAttachment: m.hasAttachment,
    preview: (m.bodyText || '').slice(0, 150),
  }));
  res.json({ items, total, page: p, pageSize: ps });
});

// 邮件详情（自动标记已读）
app.get('/api/messages/:id', (req, res, next) => {
  try {
    for (const f of fs.readdirSync(MESSAGES_DIR)) {
      if (!f.endsWith('.json')) continue;
      const list = readMessages(f.replace('.json', ''));
      const m = list.find((x) => x.id === req.params.id);
      if (m) {
        if (!m.isRead) {
          m.isRead = true;
          m.updatedAt = new Date().toISOString();
          writeMessages(m.accountId, list);
        }
        return res.json({ ...m, bodyText: m.bodyText || '', bodyHtml: m.bodyHtml || '' });
      }
    }
    res.status(404).json({ message: '邮件不存在' });
  } catch (e) { next(e); }
});

// 更新邮件（已读/星标）
app.patch('/api/messages/:id', (req, res, next) => {
  try {
    const { isRead, isStarred } = req.body || {};
    for (const f of fs.readdirSync(MESSAGES_DIR)) {
      if (!f.endsWith('.json')) continue;
      const accountId = f.replace('.json', '');
      const list = readMessages(accountId);
      const m = list.find((x) => x.id === req.params.id);
      if (m) {
        if (typeof isRead === 'boolean') { m.isRead = isRead; m.updatedAt = new Date().toISOString(); }
        if (typeof isStarred === 'boolean') { m.isStarred = isStarred; m.updatedAt = new Date().toISOString(); }
        writeMessages(accountId, list);
        return res.json(m);
      }
    }
    res.status(404).json({ message: '邮件不存在' });
  } catch (e) { next(e); }
});

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[error]', err);
  const status = err.status || 500;
  res.status(status).json({ message: err.message || '服务器内部错误' });
});

/* ==================== 启动 ==================== */
ensureDataDir();
app.listen(PORT, () => {
  console.log(`邮箱聚合助手已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
