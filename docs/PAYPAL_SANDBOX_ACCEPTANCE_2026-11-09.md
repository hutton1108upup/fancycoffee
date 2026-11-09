# PayPal Sandbox acceptance — 2026-11-09

本项目按 PayPal 官方 Sandbox 规则验收支付接入。Sandbox virtual environment/mock transactions 不触及 Live accounts；本记录不包含正式扣款、正式退款或真实资金结算。

## 当前配置

- `WAFFO_MODE=test`
- `PAYPAL_PRODUCTION_ENABLED=false`
- `paymentMode=test`
- `provider=paypal`
- `testConfigured=true`
- `productionConfigured=false`
- production callback 在 test mode 下返回 `409 ENVIRONMENT_DISABLED`

## 已验收的 Sandbox 能力

- 两个 completed `PAYMENT.CAPTURE.COMPLETED` webhook 已处理。
- 一个 `PAYMENT.CAPTURE.REFUNDED` 事件进入 `pending_review`。
- Sandbox 账本复核：1 个 paid、1 个 `refund_pending`、3 条 ledger rows、100 credits（含既有 Waffo ledger）。
- 历史验收覆盖：20 credits 到账、60 credits 到账、重复回站不重复入账、退款后 credits hold。
- 不重复消费历史 Sandbox 订单；本轮只记录已有验收状态。
- 对既有 60-credit Sandbox 订单的 PayPal API GET 已复核：订单和 capture 均为 `COMPLETED`，金额为虚拟 `$24.99`，merchant matched；本次没有新建订单或再次扣款。

## 外部账户边界

- APIMart 今日充值已成功，余额从 13.23 增至 113.23；自动充值未配置，且没有保存卡。证据保存在私有截图路径。
- Live GET 订单仍是待付款状态；本轮不登录买家、不 capture、不退款、不写正式账本。
- PayPal 正式配置保留但不启用；不以 Live checkout 页面或 OAuth 预检作为正式资金验收。

官方参考：[PayPal Sandbox](https://developer.paypal.com/tools/sandbox/)。
