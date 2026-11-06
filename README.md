# Fancy Cafe AI

这是一个 15 页的公开页面复刻和发布预览项目。原站源码没有取得；仓库保存的是页面、字体、媒体、reference 资源，以及本项目后来编写的本地原型和 Cloudflare Worker 代码。

当前确认可用的是 `https://fancycafeaivideo.pro` 主站、`www` 到 apex 的 HTTPS 重定向和 HTTPS 静态资源。Google 登录和 Waffo Test 沙箱支付已完成一次真实流程验收；生产付款、真实退款和 AI 生成仍保持 disabled。外部配置阶段记录见 [`docs/EXTERNAL_SETUP.md`](docs/EXTERNAL_SETUP.md)。

## 两套运行边界

`local-server.mjs`、`auth/` 下的 Node 认证原型和本地 SQLite 测试只用于本地开发与审查。它们不代表线上运行代码。

正式 Worker 入口是 `deploy/worker.mjs`，正式认证和支付实现分别在 `deploy/auth.mjs`、`deploy/payments.mjs`，用户、OAuth flow、session 和正式账本使用 Cloudflare D1。两套边界不要混用，也不要把 Node 内存 session 当成线上持久化证明。

生成账本由 `deploy/generation-store.mjs` 和 `migrations/0003_generation.sql` 提供持久化 reservation、provider task/result 状态、CAS 提交闸门和 owner/environment 隔离；它是状态与积分会计契约，不代表真实付费 provider 生成已完成。

线上已创建并应用 schema：

- `APP_DB`：`fancycoffee-app`，包含 `users`、`oauth_flows`、`sessions` 和 4 张支付表。
- `BILLING_TEST_DB`：`fancycoffee-billing-test`，仅包含支付表。
- `APP_DB` 已验证 `users=1`、`sessions=1`；正式订单、正式 ledger 和正式 credits 均为 0。Test 账本有 1 次已验证的 20 credits 沙箱授信，未混入 `APP_DB`。

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
npx wrangler deploy
```

GitHub push 不会自动部署 Worker。发布前使用 `dist/release.json` 核对构建信息；没有有效 Git revision 时会记录 `unknown`，不会伪造 SHA。

## 正式配置

本地变量模板见 `.dev.vars.example`，正式 secret 放 Cloudflare Worker secret，不要发到聊天，也不要提交 Git。

- Google OAuth callback：`https://fancycafeaivideo.pro/auth/google/callback`
- Waffo test webhook：`https://fancycafeaivideo.pro/api/waffo/webhook/test`
- Waffo production webhook：`https://fancycafeaivideo.pro/api/waffo/webhook/production`
- 商品：20 credits `$9.99`、60 credits `$24.99`、200 credits `$69.99`，均为一次性 USD 套餐。
- Google 登录需要 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 和 `APP_DB`。
- 支付需要对应 `WAFFO_TEST_*` 或 `WAFFO_PRODUCTION_*`、产品 ID 以及 `BILLING_TEST_DB` 或 `APP_DB`。

provider 没有配置时接口会明确返回未配置状态，不会伪造登录、支付、积分或视频结果。

## 验证边界

本地 mock、Node SQLite 和 Worker 单元测试验证的是代码契约；真实 Google 登录和一次 Waffo Test 沙箱 checkout/webhook/D1 授信已有独立证据，但不等于真钱收款、退款、生产资源或 AI 已验证。2026-11-05 的浏览器记录中，旧标签页绑定曾出现 `Emulation.setFocusEmulationEnabled` 超时；新建 Chrome 标签页可通过可访问性状态、点击和输入完成外部配置操作。未读取旧项目凭据，也未复用其他项目密钥。

仓库上传和本地保留范围见 [`REPOSITORY_GUIDE.md`](REPOSITORY_GUIDE.md)。
