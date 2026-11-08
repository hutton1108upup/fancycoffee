# PayPal 配置说明

本文只说明 Fancy Cafe 的 PayPal 接入边界。密钥、客户端密码、商户私有数据和完整的私有 JSON 不写入仓库，也不要发到聊天；本地私有文件可放在 `.secrets/`。

## 当前状态

- PayPal sandbox 资源已创建；真实 sandbox 买家付款、回站重复访问、取消订单、签名 webhook 与退款冻结已验证。
- 验证覆盖：$9.99 订单到账 20 credits，重复回站不重复记账；$24.99 取消订单保持 pending 且不发 credits；退款 webhook 后订单为 `refund_pending`，20 credits 为 hold。以上不是正式真钱验证。
- `migrations/0004_paypal.sql` 已应用到正式 `APP_DB` 与测试 `BILLING_TEST_DB`；旧 Waffo ledger 保留。
- 2026-11-08 已在既有中国账户创建唯一 Fancy Cafe AI Live 资源；正式 webhook 已创建并完成只读预检。不要重新创建应用或重复迁移。
- Live 预检结果：OAuth 有效、webhook HTTP 200、ID 和 URL 匹配，缺失事件与意外事件均为空。预检不创建订单，也不代表真实收款已验证。
- 2026-11-08 readiness 复核：正式配置与已登录 PayPal.cn 胡晓成商户页面的归属已核对；这是配置归属核验，不是交易级验证。预检脚本仍输出 `merchantOwnershipVerified=false`，因为该脚本本身不验证商户归属。
- 2026-11-08 已进入正式模式：`paymentMode=prod`、`provider=paypal`、`productionConfigured=true`；正式入口和配置门禁已打开，但正式实付、capture、到账和退款闭环仍未验收。
- 当前全项目 104 tests 和 build 已通过；最终发布以 `release.json` 和对应 PR 为准。
- 当前 Worker secrets 已写入 Cloudflare Worker：四项 `PAYPAL_PRODUCTION_*`（client ID、client secret、merchant ID、webhook ID）、`PAYPAL_PRODUCTION_ENABLED=true`，以及 `WAFFO_MODE=production`。本文不记录 secret 值或 client ID。
- `health.paymentMode.productionConfigured` 只有在正式凭据齐全且生产开关打开时才为 `true`；本次已为 `true`，但真实交易仍未完成验收。
- 生成侧已完成两条受控 15 秒验证（Person 与 Pet），包含实际下载和浏览器完整播放；这两条生成测试不代表 production paid end-to-end。
- `APP_DB` 用于正式用户与正式账本；`BILLING_TEST_DB` 只用于测试账本。不要把测试订单写入正式库。
- `WAFFO_MODE=prod|production` 选择 production，其他值选择 test；`BILLING_PROVIDER=paypal` 选择 PayPal，未满足配置时付款保持 disabled。

## 配置项

按当前模式配置以下环境变量，值只放 Cloudflare Worker secrets 或本地 `.dev.vars`，不要写入 Git：

```text
BILLING_PROVIDER=paypal
PAYPAL_ENABLED=true
PAYPAL_PRODUCTION_ENABLED=true       # 当前正式入口已打开；真实交易仍需单独授权验收
PAYPAL_TEST_CLIENT_ID=...
PAYPAL_TEST_CLIENT_SECRET=...
PAYPAL_TEST_MERCHANT_ID=...
PAYPAL_TEST_WEBHOOK_ID=...
PAYPAL_PRODUCTION_CLIENT_ID=...
PAYPAL_PRODUCTION_CLIENT_SECRET=...
PAYPAL_PRODUCTION_MERCHANT_ID=...
PAYPAL_PRODUCTION_WEBHOOK_ID=...
```

固定回调地址：

- sandbox webhook：`https://fancycafeaivideo.pro/api/paypal/webhook/test`
- production webhook：`https://fancycafeaivideo.pro/api/paypal/webhook/production`
- 用户回站由服务端生成到 `/pricing?order=<localOrder>&paypal_return=1`；取消使用 `paypal_cancel=1`。

sandbox API 是 `https://api-m.sandbox.paypal.com`，production API 是 `https://api-m.paypal.com`。只允许与当前模式匹配的 PayPal checkout host；浏览器回站的 `token`/`PayerID` 不作为授信依据，订单归属和支付状态必须由服务端确认。

## 配置步骤

1. 现有 Fancy Cafe AI Live 已创建；后续操作先读取并核对现有应用和 webhook，不要再次创建同名应用、重复迁移或替换既有资源。
2. `migrations/0004_paypal.sql` 已在目标 D1 各应用一次；后续部署不要重复执行同一迁移，保持正式库与测试库隔离。
3. Sandbox 与 Live 应用均已存在；不要重复新建。把私有结果分别保存到 `.secrets/paypal-sandbox.json` 和 `.secrets/paypal-production.json`，不要提交或粘贴其内容。
4. 用已批准的私有 JSON 运行 `node scripts/paypal-production-preflight.mjs <path>`。该脚本只允许访问正式 `api-m.paypal.com` 的 OAuth 和 GET webhook 配置，输出安全摘要并明确 `merchantOwnershipVerified=false`；不创建订单，不执行 capture/refund。Sandbox 预检仍属于本地维护工具，不是公开支付接口。
5. sandbox 的真实回站、重复回站、取消、签名 webhook 和退款冻结已经验证。当前 Live 已能创建 `$9.99 / 20 credits` 的待付款订单，收银台收款人匹配，但尚未支付；真实 capture、正式回调到账和正式退款仍未验证。不要把待付款订单写成正式收入。

## 退款与积分

PayPal 退款/撤销 webhook 会把订单置为 `refund_pending`/`pending_review`。sandbox 退款后冻结积分的流程已真实验证；相关积分会保持冻结或 hold，接口返回真实的 `heldCredits` 时前端会显示冻结数量。系统不会自动替用户发起退款，也不会把待审核状态说成已退款。production 真钱和人工最终审核流程尚未验证。

