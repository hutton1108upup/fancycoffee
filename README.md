# Fancy Cafe AI

这是一个 16 个静态页面（含 `/examples/`）的公开页面复刻和发布预览项目。原站源码没有取得；仓库保存的是页面、字体、媒体、reference 资源，以及本项目后来编写的本地原型和 Cloudflare Worker 代码。

当前确认可用的是 `https://fancycafeaivideo.pro` 主站、`www` 到 apex 的 HTTPS 重定向和 HTTPS 静态资源。Google 登录、PayPal 官方 Sandbox 付款/回站/积分验收，以及合成人物和金毛案例的真实生成与下载已完成；Sandbox 不进行真钱扣款，公开生成仍是受控能力。统一产品事实见 [`docs/PRODUCT_FACTS.md`](docs/PRODUCT_FACTS.md)，Sandbox 证据见 [`docs/PAYPAL_SANDBOX_ACCEPTANCE_2026-11-09.md`](docs/PAYPAL_SANDBOX_ACCEPTANCE_2026-11-09.md)，公开案例见 [`/examples/`](examples/)。

## 两套运行边界

`local-server.mjs`、`auth/` 下的 Node 认证原型和本地 SQLite 测试只用于本地开发与审查。它们不代表线上运行代码。

正式 Worker 入口是 `deploy/worker.mjs`，正式认证和支付实现分别在 `deploy/auth.mjs`、`deploy/payments.mjs`，用户、OAuth flow、session 和正式账本使用 Cloudflare D1。两套边界不要混用，也不要把 Node 内存 session 当成线上持久化证明。

生成账本由 `deploy/generation-store.mjs` 和 `migrations/0003_generation.sql` 提供持久化 reservation、provider task/result 状态、CAS 提交闸门和 owner/environment 隔离。历史受控生成记录仍保留在验收材料中；当前公开案例和产品事实以 `/examples/` 与 [`docs/PRODUCT_FACTS.md`](docs/PRODUCT_FACTS.md) 为准。这不等于生产 key、生产预算或普通公测已开启。

线上已创建并应用 schema：

- `APP_DB`：`fancycoffee-app`，包含 `users`、`oauth_flows`、`sessions` 和 4 张支付表。
- `BILLING_TEST_DB`：`fancycoffee-billing-test`，仅包含支付表。
- 旧验收材料中的数据库计数属于历史快照，不作为当前线上数据承诺；正式真钱账本仍关闭，Sandbox 账本与正式库保持隔离。

## 本地检查

在项目目录运行：

```powershell
npm ci
npm test
npm run build
npm run deploy:dry-run
```

`npm start` 只启动 Node 本地原型。Worker 发布由已授权的 Cloudflare 身份手动执行：

```powershell
npx wrangler deploy --keep-vars
```

GitHub push 不会自动部署 Worker。发布前使用 `dist/release.json` 核对构建信息；没有有效 Git revision 时会记录 `unknown`，不会伪造 SHA。

## 正式配置

本地变量模板见 `.dev.vars.example`，正式 secret 放 Cloudflare Worker secret，不要发到聊天，也不要提交 Git。

- Google OAuth callback：`https://fancycafeaivideo.pro/auth/google/callback`
- PayPal Sandbox webhook：`https://fancycafeaivideo.pro/api/paypal/webhook/test`
- PayPal production webhook：`https://fancycafeaivideo.pro/api/paypal/webhook/production`（正式真钱关闭）
- 商品：20 credits `$9.99`、60 credits `$24.99`、200 credits `$69.99`，均为一次性 USD 套餐。
- Google 登录需要 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 和 `APP_DB`。
- 支付配置见 [`docs/PAYPAL_SETUP.md`](docs/PAYPAL_SETUP.md)，当前为 PayPal Sandbox；已配置的正式凭据不代表启用正式收款，生产激活保持关闭。

provider 没有配置时接口会明确返回未配置状态，不会伪造登录、支付、积分或视频结果。

## 验证边界

本地 mock、Node SQLite 和 Worker 单元测试验证的是代码契约；另有独立证据证明 Google 登录、PayPal Sandbox checkout/回站/webhook/D1 授信，以及合成人物和金毛案例的生成与下载。真钱收款、生产退款、Closer/720p 和普通公测仍未启用。浏览器工具限制和外部验收边界见对应证据文档；未读取旧项目凭据，也未复用其他项目密钥。

仓库上传和本地保留范围见 [`REPOSITORY_GUIDE.md`](REPOSITORY_GUIDE.md)。
