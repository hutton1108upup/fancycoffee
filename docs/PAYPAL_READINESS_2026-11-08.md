# PayPal Live readiness — 2026-11-08

这份记录只说明正式收款准备状态，不代表已开启正式扣款。

## 已核对

- 正式配置与已确认的 PayPal.cn 商户页面归属相符；页面核对属于配置归属验证，不是交易级验证，也不公开完整商户 ID 或邮箱。
- Live OAuth 成功；GET webhook 返回 HTTP 200，webhook ID、production callback URL 和 7 个已订阅事件均匹配，无缺失事件。
- 4 个既有 production secrets 已重新同步到原 Cloudflare Worker；production flags 仍为关闭，服务端模式仍为 test。
- 线上 production webhook 空体 POST 返回 `409 ENVIRONMENT_DISABLED`；test webhook 空体 POST 返回 `401 HEADERS_MISSING`。这些请求没有付款或充值。
- D1 production 库当前存在 4 个支付表；`payment_orders`、`credit_ledger`、`paypal_webhook_events` 三类记录均为 0 行。
- Sandbox 库有 2 个 completed signed webhook、1 个 refunded 事件，支付 ledger 为 3 rows / 100 credits；与本轮两条受控生成后 available 20 credits 相容。

## 尚未完成

- 没有创建正式订单，没有真实美元扣款，也没有真实正式退款；正式账本入账必须以后在用户明确授权下做交易验收。
- PayPal.cn 个人账户页面的人民币产品尚未开通；这只是境内人民币结算服务状态，不能把它解释为已验证的美元 checkout 障碍。
- 是否需要补充 KYC 资料必须以 PayPal 后台实际提示为准，不能预先编造必需资料。
- 生产开关保持关闭；Live App 已存在不等于 production ready。

PayPal.cn 通知中心已实际展开并显示“恭喜您开户成功”“您的账户信息已通过审核，请开始第一笔收款”。本次没有点击“开始收款”，也没有观察到新增 KYC 要求；当前没有需要用户重复提供的姓名、邮箱或证件资料。正式启用仍需另行明确真实收款/退款测试授权和预算，不要求现在提供秘密。

Developer 登录跳转到 `.cn` 后出现 page-not-found；通过中国“PayPal按钮”打开的新标签页没有有效 URL，并被浏览器安全策略拒绝，已停止该 UI 路径，没有尝试绕过。正式应用有效性以 Live API 成功和既有资源配置为依据，不声称本轮已打开 Live 应用 UI。

## 证据边界

预检脚本的 `merchantOwnershipVerified=false` 是脚本能力边界：脚本只做 Live OAuth 与 webhook GET。浏览器已另外核对正式配置归属，两者不能混写成 API 已验证商户归属。

本轮不重复索要已经确认的姓名、邮箱、售价或密钥，也不记录 secret 内容。截图证据保存在私有路径：`.data/evidence/paypal-live-merchant-verified-2026-11-08.png`。
