# PayPal 配置说明

本文只说明 Fancy Cafe 的 PayPal 接入边界。密钥、客户端密码、商户私有数据和完整的私有 JSON 不写入仓库，也不要发到聊天；本地私有文件可放在 `.secrets/`。

## 当前状态

- 2026-11-09 后续恢复：`WAFFO_MODE=production`、`PAYPAL_PRODUCTION_ENABLED=true`；线上 health 显示 PayPal production 和 checkout 已配置。Sandbox 验收期间的 test 状态为历史状态，正式付款与生成的真实端到端仍未验收。生成报价截止 2026-11-15 09:40 UTC，到期前需重新核实并更新。
- PayPal sandbox 资源已创建；真实 sandbox 买家付款、回站重复访问、取消订单、签名 webhook 与退款冻结已验证。
- 验证覆盖：$9.99 订单到账 20 credits，重复回站不重复记账；$24.99 取消订单保持 pending 且不发 credits；退款 webhook 后订单为 `refund_pending`，20 credits 为 hold。以上不是正式真钱验证。
- `migrations/0004_paypal.sql` 已应用到正式 `APP_DB` 与测试 `BILLING_TEST_DB`；旧 Waffo ledger 保留。
- 2026-11-08 已在既有中国账户创建唯一 Fancy Cafe AI Live 资源；正式 webhook 已创建并完成只读预检。不要重新创建应用或重复迁移。
- Live 预检结果：OAuth 有效、webhook HTTP 200、ID 和 URL 匹配，缺失事件与意外事件均为空。预检不创建订单，也不代表真实收款已验证。
- 2026-11-08 readiness 复核：正式配置与已登录 PayPal.cn 胡晓成商户页面的归属已核对；这是配置归属核验，不是交易级验证。预检脚本仍输出 `merchantOwnershipVerified=false`，因为该脚本本身不验证商户归属。
- 2026-11-09 当前保持 Sandbox 模式：`WAFFO_MODE=test`、`PAYPAL_PRODUCTION_ENABLED=false`、`paymentMode=test`、`testConfigured=true`、`productionConfigured=false`。正式配置保留但不启用。
- 2026-11-08 历史验收记录显示全项目 104 tests 和 build 通过；最终发布以 `release.json` 和对应 PR 为准，本句不是本次重跑结果。
- 当前 Worker 保持测试配置；正式配置不启用。本文不记录 secret 值或 client ID。
- 当前 `health.paymentMode.productionConfigured=false`；正式凭据可保留，但 production 开关关闭。
- 生成侧已完成两条受控 15 秒验证（Person 与 Pet），包含实际下载和浏览器完整播放；这两条生成测试不代表 production paid end-to-end。
- `APP_DB` 用于正式用户与正式账本；`BILLING_TEST_DB` 只用于测试账本。不要把测试订单写入正式库。
- `WAFFO_MODE=prod|production` 选择 production，其他值选择 test；`BILLING_PROVIDER=paypal` 选择 PayPal，未满足配置时付款保持 disabled。

## 配置项

按当前模式配置以下环境变量，值只放 Cloudflare Worker secrets 或本地 `.dev.vars`，不要写入 Git：

```text
BILLING_PROVIDER=paypal
PAYPAL_ENABLED=true
WAFFO_MODE=test
PAYPAL_PRODUCTION_ENABLED=false      # 当前保持关闭；正式配置不启用
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
5. 按 PayPal 官方 Sandbox 说明，Sandbox 的 virtual environment/mock transactions 不触及 Live accounts；本项目以 Sandbox 模拟成功、回站重复访问、取消、签名 webhook 和退款冻结作为支付接入验收，不要求 Live 实付。参考：[PayPal Sandbox](https://developer.paypal.com/tools/sandbox/)。正式模式仍保持关闭。

## 退款与积分

PayPal 退款/撤销 webhook 会把订单置为 `refund_pending`/`pending_review`。sandbox 退款后冻结积分的流程已真实验证；相关积分会保持冻结或 hold，接口返回真实的 `heldCredits` 时前端会显示冻结数量。系统不会自动替用户发起退款，也不会把待审核状态说成已退款。production 真钱和人工最终审核流程尚未验证。

