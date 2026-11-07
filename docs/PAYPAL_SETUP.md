# PayPal 配置说明

本文只说明 Fancy Cafe 的 PayPal 接入边界。密钥、客户端密码、商户私有数据和完整的私有 JSON 不写入仓库，也不要发到聊天；本地私有文件可放在 `.secrets/`。

## 当前状态

- PayPal sandbox 资源已创建；真实 sandbox 买家付款、回站重复访问、取消订单、签名 webhook 与退款冻结已验证。
- 验证覆盖：$9.99 订单到账 20 credits，重复回站不重复记账；$24.99 取消订单保持 pending 且不发 credits；退款 webhook 后订单为 `refund_pending`，20 credits 为 hold。以上不是正式真钱验证。
- `migrations/0004_paypal.sql` 已应用到正式 `APP_DB` 与测试 `BILLING_TEST_DB`；旧 Waffo ledger 保留。
- 正式 production 仍 disabled；当前 AI quote 已过期且 restrictedTest，不应视为可公开收费能力。
- `APP_DB` 用于正式用户与正式账本；`BILLING_TEST_DB` 只用于测试账本。不要把测试订单写入正式库。
- `WAFFO_MODE=prod|production` 选择 production，其他值选择 test；`BILLING_PROVIDER=paypal` 选择 PayPal，未满足配置时付款保持 disabled。

## 配置项

按当前模式配置以下环境变量，值只放 Cloudflare Worker secrets 或本地 `.dev.vars`，不要写入 Git：

```text
BILLING_PROVIDER=paypal
PAYPAL_ENABLED=true
PAYPAL_PRODUCTION_ENABLED=false      # 默认关闭；正式激活前才改为 true
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

1. 由已确认的 Cloudflare 账号为对应 Worker 设置上述 secrets，并核对 `APP_DB` 与 `BILLING_TEST_DB` 的绑定。
2. 在目标 D1 分别应用 `migrations/0004_paypal.sql`，保持正式库与测试库隔离。
3. 在 PayPal Developer Dashboard 创建 sandbox 应用和 webhook；把私有结果保存到 `.secrets/paypal-sandbox.json`，不要提交或粘贴其内容。
4. 用已批准的私有 JSON 运行 `.data/paypal-sandbox-preflight.mjs <path>`。脚本只输出安全摘要，不打印 token、client secret 或原始响应。
5. 先完成 sandbox 真实回站、重复回站、取消、webhook 和退款/撤销审核验证，再单独配置 production；当前正式付款仍以“待根 Agent 验证”为准。正式启用 production 前，明确将 `PAYPAL_PRODUCTION_ENABLED` 改为 `true`。

## 退款与积分

PayPal 退款/撤销 webhook 会把订单置为 `refund_pending`/`pending_review`。相关积分会保持冻结或 hold，接口返回真实的 `heldCredits` 时前端会显示冻结数量；系统不会自动替用户发起退款，也不会把待审核状态说成已退款。退款、撤销和积分最终状态仍需真实 PayPal 流程验证。

