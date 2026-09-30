# Email Aggregator · 邮箱聚合助手

> 轻量、零依赖、单进程的多邮箱聚合客户端。本地运行，数据存本机，无数据库、无构建步骤。

把多个邮箱账号（QQ / 163 / Gmail / Outlook / 自建等）聚合到一个统一界面，集中收件、搜索、查看。账号密码用 AES-256-GCM 加密后落盘，所有数据只存在你本机。

## 功能特性

- **多账号聚合**：一次配置多个邮箱，左侧栏统一管理，独立未读角标
- **多协议**：IMAP（推荐，功能完整）/ POP3 / SMTP 连接测试；Exchange 走 IMAP 端点提示
- **邮件同步**：拉取 INBOX 最近 N 封，增量 upsert（按 folder + UID 去重，保留本地已读/星标）
- **统一收件箱**：跨账号聚合列表，支持「全部 / 未读 / 已加星」筛选 + 关键词搜索 + 分页
- **正文渲染**：iframe 沙箱隔离 + 配色归一化（剥暗色媒体查询、强制白底深字），自适应高度，避免邮件样式污染主界面
- **安全**：授权码 AES-256-GCM 加密存储，密钥可由环境变量覆盖
- **设置面板**（顶栏 ⚙）：集中管理账号增删改、配置翻译服务 API Key（实时生效、密钥仅以掩码回显）、切换浅色/深色/跟随系统主题、收起账号列表与邮件列表、一键删除全部账号
- **邮件翻译（本地 AI 模型）**：接入任意 OpenAI 兼容接口（FreeLLMAPI / LM Studio / Ollama / DeepSeek 等）一键翻译；译文**按原邮件版式渲染**（逐文本节点翻译、保留 HTML 结构），非纯文本堆砌
- **零依赖部署**：仅需 Node.js + npm install，无数据库、无构建工具

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js + Express |
| 邮件协议 | `imapflow`（IMAP）、`poplib`（POP3）、`nodemailer`（SMTP）、`mailparser`（MIME 解析） |
| 存储 | JSON 文件（`data/accounts.json` + `data/messages/<accountId>.json`） |
| 加密 | `crypto` AES-256-GCM |
| 前端 | 原生 HTML/CSS/JS（单文件，无框架、无构建） |

## 快速开始

### 环境要求

- Node.js ≥ 18
- Windows / macOS / Linux

### 安装与运行

```bash
git clone https://github.com/szl-qq/Email-aggregator.git
cd Email-aggregator
npm install
npm start
```

浏览器打开 http://localhost:3000

Windows 用户也可双击 `一键启动.bat`（自动检查依赖、停旧实例、启动并打开浏览器）；停止用 `一键停止.bat`。

### 添加邮箱账号

1. 在网页左侧栏点「＋ 添加账号」
2. 选择协议（推荐 IMAP）、填写显示名、邮箱地址、服务器地址、端口、勾选 SSL/TLS
3. 填用户名与**授权码**（QQ / 163 等需在邮箱网页端开启 IMAP/SMTP 后获取授权码，不是登录密码）
4. 点「测试连接」验证通过后保存
5. 账号旁点 ↻ 同步邮件

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `EMAIL_KEY` | 内置默认 | AES-256-GCM 密钥（32 字节 hex）。**生产部署务必覆盖**，见下方安全说明 |
| `TRANSLATE_LLM_URL` | `http://127.0.0.1:31415/v1/chat/completions` | 翻译用的 OpenAI 兼容接口 |
| `TRANSLATE_LLM_KEY` | `lm-studio` | 接口密钥（本地网关可任意填） |
| `TRANSLATE_LLM_MODEL` | `auto` | 翻译模型名（可指定如 `deepseek-chat`） |
| `TRANSLATE_TARGET` | `简体中文` | 翻译目标语言 |
| `TRANSLATE_MAX_LEN` | `6000` | 单封邮件翻译的最大字符数 |
| `TRANSLATE_MAX_SEGS` | `80` | 版式渲染时最多翻译的文本节点数 |

> 推荐做法：复制 `.env.example` 为 `.env` 填入配置（`.env` 已在 `.gitignore` 中，密钥不会进仓库）。环境变量优先级高于 `.env`。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/accounts` | 账号列表（不含密码） |
| POST | `/api/accounts` | 添加账号 |
| PATCH | `/api/accounts/:id` | 更新账号 |
| DELETE | `/api/accounts/:id` | 删除账号（连同邮件） |
| DELETE | `/api/accounts` | 删除全部账号及其邮件缓存 |
| GET | `/api/settings` | 读取设置（密钥仅返回掩码） |
| PUT | `/api/settings` | 保存设置（翻译服务 URL / Key / 模型 / 目标语言，实时生效） |
| POST | `/api/settings/test-translate` | 用当前配置试译一句，验证连通性 |
| POST | `/api/accounts/test-connection` | 测试连接（不保存） |
| POST | `/api/accounts/:id/sync` | 同步邮件 |
| GET | `/api/messages` | 邮件列表（支持 `accountId`/`isRead`/`isStarred`/`keyword`/`page`/`pageSize`） |
| GET | `/api/messages/:id` | 邮件详情（自动标记已读） |
| PATCH | `/api/messages/:id` | 更新已读/星标 |
| POST | `/api/messages/:id/translate` | 翻译邮件，返回译文文本 + 按原版式渲染的 HTML |

## 项目结构

```
.
├── server.js              # 后端：Express + 邮件协议 + 加密 + JSON 存储
├── public/
│   └── index.html         # 前端：单文件 UI
├── data/                  # 运行时数据（gitignore，自动创建）
│   ├── accounts.json      # 加密后的账号配置
│   └── messages/          # 按账号分文件的邮件缓存
├── 一键启动.bat            # Windows 一键启动
├── 一键停止.bat            # Windows 一键停止
├── .gitignore
├── LICENSE
└── README.md
```

## 安全说明

- **授权码加密**：账号密码用 AES-256-GCM 加密后存入 `data/accounts.json`，密钥默认内置、可用 `EMAIL_KEY` 环境变量覆盖。
- **默认密钥风险**：本仓库源码公开，内置默认密钥任何人可见。仅适用于本地单用户场景。**多用户 / 服务器部署务必设置 `EMAIL_KEY` 为随机 32 字节 hex 值**，否则任何拿到 `data/` 的人都能解密你的授权码。
- **数据本地**：所有账号配置与邮件缓存只存在你本机 `data/` 目录，不上传任何远端。删除账号会同步删除其邮件文件。
- **沙箱渲染**：邮件 HTML 正文在 `sandbox` iframe 内渲染，禁用脚本执行，避免邮件内的跟踪脚本与样式污染。

## 已知限制

- POP3 仅支持连接测试，邮件同步暂未实现（建议用 IMAP）。
- Exchange 不直连 EWS，建议改用 IMAP 端点。
- 仅同步 INBOX，不支持自定义文件夹与发件。
- 无 OAuth2 支持（Gmail 等需用「应用专用密码」或授权码）。

## License

MIT，见 [LICENSE](./LICENSE)。
