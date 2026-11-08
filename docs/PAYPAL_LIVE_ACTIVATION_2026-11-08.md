# PayPal Live activation — 2026-11-08

本记录区分“正式入口已打开”和“真实交易已验收”。

## 当前已验证

- Cloudflare Worker 当前为正式模式，`paymentMode=prod`、`provider=paypal`、`productionConfigured=true`。
- Live OAuth 和 production webhook 配置读取成功；7 个事件完整，callback URL 与配置匹配。
- 正式 D1 已应用 generation migration；payment 表原有 0 orders、0 ledger，切换前没有把 Sandbox 积分带入正式库。
- Chrome 已从网站创建一笔 `$9.99 / 20 credits` 的 Live 待付款订单，PayPal 收银台已打开，收款人匹配；尚未登录 buyer、尚未支付。
- 该订单状态仍为 `PAYER_ACTION_REQUIRED`，不是 paid，也没有产生正式 ledger 入账。
- 当前全项目 104 tests 和 build 已通过；最终发布以 `release.json` 和对应 PR 为准。

## 仍未验收

- 没有执行真实 buyer 登录、capture 或 `PAYMENT.CAPTURE.COMPLETED` 正式 webhook 验收。
- 没有执行正式退款、撤销或 `refund_pending/heldCredits` 的 Live 验收。
- 不把待付款订单、OAuth 成功或 webhook 配置成功写成正式收入或正式支付可用证明。
- PayPal Developer 登录当前受 rate limit 影响，停止反复刷新；这不影响已通过 Live API 验证的现有资源配置。
- APIMart 当前实际余额仅支持少量生成，补充资金待确认。
- 供应商余额偏低，补充资金另行取得用户授权；公开文档不记录账户余额或完整订单 ID。

线上空体回调边界：正式 callback 返回 `401 PAYPAL_WEBHOOK_HEADERS_MISSING`，Sandbox callback 返回 `409 ENVIRONMENT_DISABLED`；两者均未产生付款或充值。

## 下一步门槛

正式模式允许已登录且余额足够的用户按模板提交；测试模式仍保留 owner/exact-hash 限制。公开付款入口已启用，但实付、capture、到账和退款仍未验收。待用户明确授权和预算后，再执行一次真实 Live buyer payment，并核对 capture、签名 webhook、D1 ledger、重复 webhook 和退款冻结。
