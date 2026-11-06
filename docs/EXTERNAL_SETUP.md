# Fancy Cafe AI 外部配置记录

记录日期：2026-11-05（Asia/Singapore）。

本文只记录已观察到的外部配置阶段。它不包含 secret、私钥、challenge 值或 OAuth code。已验证的 Google 登录和 Waffo Test 沙箱结果与仍待验收的生产边界分开记录。

## 已准备并可恢复的 Waffo Test 配置

Waffo 账户和资源归属记录：

- 账户：`duckweed1014@gmail.com`
- Merchant：`MER_0Ca1DBngIQV3s35pRE1wcg`
- 专属店铺：`Fancy Cafe AI`
- Store：`STO_1i9FfGp3YtHVVNuYP1wDWX`
- Store slug：`fancy-cafe-ai-jy9f1kn9`

Test 一次性商品已创建、价格已设置、当前显示为销售中：

| 套餐 | Product ID | 价格 | 计费 |
| --- | --- | ---: | --- |
| 20 credits | `PROD_06WDV6X1UPKmp0Xz11Oqlj` | `$9.99` | 一次性 |
| 60 credits | `PROD_6awl2ymwA0qUSsBRX0SBWL` | `$24.99` | 一次性 |
| 200 credits | `PROD_6NxpmkmpgMimHkvE3qVt3g` | `$69.99` | 一次性 |

这些商品没有订阅周期，也没有计划过期设置。

Waffo 已显示 `fancycafeaivideo.pro` DNS 验证成功。记录的资源是：

- Cloudflare Zone：`4574a0de4bd0cdec14ebe983de7a34f7`
- TXT 记录名称：`_waffo-challenge`
- Cloudflare DNS record ID：`600aa32e39a6bd01f809c8fcfe8c96ac`

challenge 值不写入本文。

Test webhook 已注册：

- Webhook ID：`cd641b28-100d-4624-bfea-f7c2ff113118`
- URL：`https://fancycafeaivideo.pro/api/waffo/webhook/test`
- 事件：`order.completed`、`refund.succeeded`、`refund.failed`

本店 Test RSA webhook 公钥已从店铺 UI 读取并完成本地格式验证；本项目专用 Test key 已创建并保存到本项目忽略目录/Worker secrets。Test webhook 私钥/API private key 不写入文档，也未复用其他项目 key。真实沙箱付款回调已通过本店 webhook 进入 D1 验证。

## Google 配置阶段

已观察到的 Google 资源：

- 账户与 Waffo 使用同一 email：`duckweed1014@gmail.com`
- Organization：`duckweed1014-org`
- Organization ID：`758218663501`
- Project：`fancycafe-ai-duckweed1014`
- 显示名：`Fancy Cafe AI`

Google 应用品牌、首页、Privacy、Terms、授权域名、外部受众和联系邮箱已保存。用户数据政策已确认，Audience 已切换为“正式版 / 外部”。Web OAuth client `Fancy Cafe AI Web` 已创建，Client ID/Secret 已部署到 Worker；本文不记录凭据值。现阶段已完成一次真实 Google 登录流程：网站 Sign in → 选择 `duckweed` → 同意基础资料 → 返回 pricing，页面显示用户邮箱；`APP_DB` 读到 `users=1`、`sessions=1`，刷新后 session 仍有效。

代码使用的 callback 必须保持：

```text
https://fancycafeaivideo.pro/auth/google/callback
```

部署前需要在 Worker secret 中配置 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`；`APP_DB` 已作为 Worker binding 使用。不要把 OAuth secret 写入仓库或聊天。

## Waffo Test key 阶段

Waffo 专用测试 key `Fancy Cafe AI Test 2026-11-05` 已创建并保存；私钥仅创建后显示一次，之后不可恢复或再次下载。密钥存于本项目忽略目录/Worker secrets，不得复用其他项目的 Waffo key。

因此当前状态是“Test 资源、凭据和沙箱链路已完成验证”，不等于生产收款已开启。

## 已验证的 Test 沙箱支付

Waffo GraphQL API 已返回本店 3 个 `active` Test 商品。`prodEnabled=false`，生产环境仍关闭。

一次真实 Waffo Test 沙箱 Visa 付款已完成，不是本地 mock，也没有真钱扣款：

- 本地订单：`3dcf0cfb-fbfd-46ef-ba45-6b6eafa3332d`
- 金额：`$9.99`
- 套餐：20 credits
- `payment_orders.status`：`paid`
- fulfillment rows：`1`
- ledger rows：`1`
- Test credits：`20`
- Waffo 完成后返回 `pricing?order=...`，页面显示 server confirmed、20 credits available 和该订单 `paid`

已保存的本地证据文件：

- `.data/evidence/waffo-test-paid.jpg`
- `.data/evidence/google-auth-published.jpg`
- `.data/evidence/waffo-test-products.jpg`
- `.data/evidence/account-test-credits-20.jpg`

account 截图首次捕获曾超时；后来通过新建 Chrome 标签页已成功保存 `.data/evidence/account-test-credits-20.jpg`。此前的可访问性状态、D1 数据和页面行为证据仍保留。

## 生产状态

生产店铺尚未通过 Waffo 资质审核。生产收款保持 disabled；没有生产 merchant/product/key/webhook 的上线证据。

### 生产审核待办

本店 Settings → Business Details 页面显示审核表共 12 步，包含：业务类型、税务居住国家/地区、产品就绪状态、现有付费客户、全名、商家名称、联系邮箱、产品网站 URL、背景/公开社交资料、产品平台描述、合规透明度声明，以及手续费定价。

当前已观察到的网页信息：

- 最终费率页面显示成功交易按 `3.9% + $0.50` 收取，无月费、无接入费。
- 完整费率说明见 [Waffo Merchant of Record fees](https://docs.waffo.ai/zh/mor/fees)。
- 费率协议尚未接受。
- 页面提示 AIGC 生成前需要关键词扫描，参考 [Waffo Content Safety scan-prompt](https://docs.waffo.ai/zh/api-reference/endpoints/content-safety/scan-prompt)。本项目尚未实施该扫描，不把页面提示当成已完成能力。

仍待用户确认、填写和最终提交：

1. 主体/业务类型与税务居住国家或地区。
2. 全名、已有付费客户情况、真实背景和公开社交资料。
3. 产品就绪状态、平台描述、合规透明度声明及网站资料。
4. 用户确认后再接受费率协议并提交审核。

审核截图保存在 `.data/evidence/waffo-business-review.jpg`。在这些资料确认和提交前，生产资质与生产收款继续保持 disabled。

真实 Google 授权、Waffo Test checkout、签名 webhook、D1 订单状态变更和积分授信已完成一次 Test 端到端验收。`APP_DB` production orders、ledger rows 和 credits 均为 0，Test 积分没有混入正式库。真实真钱扣款、退款、生产 key/product/webhook 尚未验证；生产资质未开通，Test 成功不代表生产收款。退款事件当前为 `pending_review`，没有自动回收积分能力。AI 已完成一次受控 Test 生成，但生产生成和对外开放仍未接通。

## 2026-11-06 受控 Test 生成验收

使用受控测试账号，在正式 Worker 页面 `?sample=1` 选择本站原创木偶 PNG，沿同一 `photo-lead` change、校验、预览和 multipart Generate 路径完成一次真实供应商 Test 生成：

- 模型：标准 `seedance-2.0`，480p，15 秒，图生视频。
- 网站消耗：20 credits。
- Provider task：`task_01M6QB0W51XYPRQARYMX3PPA49`。
- Provider 成本：`$0.99` / 9.9 provider credits；观察到汇率 `6.6684`，约 `¥6.60`。
- Provider 任务耗时：353 秒；API 余额从 42.63 降至 32.73，减少 9.90 provider credits。
- Test key 总限额：10 credits；有效期：1 天。
- D1 run：`b5ab6a20-4908-4cac-9db9-f4a5da0830ef`。
- 账本：paid 20 → reserved 20 → reserved 0，delivered 20，available 0。
- 官网刷新后恢复 owner 视频；实际下载输出 2,819,373 bytes，SHA-256 为 `71b5a7d1c537bcccd4cd7a43d564b188ed80a145f62a2dbb2d25d76c9c8b0cfc`。
- 输出完整解码为 361 帧、15.104 秒、496×864、24fps、H.264/AAC 有声。

本地证据：

- `.data/evidence/seedance-fancy-cafe.mp4`
- `.data/evidence/seedance-site-playback.jpg`
- `.data/evidence/seedance-output-check.json`
- `.data/evidence/seedance-apimart-receipt.jpg`

输入桶保留 7 天，输出桶保留 30 天。APIMart API hostname 已核对。该结果只证明一次受控 Test run；生产 key、生产预算、真实收费/退款、真人照片审批、Closer/720p 和普通公测仍未验收。对外开放生成前仍需完成生产配置和收费审核，不能把 Test key 或单次授权 run 当作无限公测能力。

## 本地/部署侧核对清单

部署前只需在已确认的目标账号和资源下核对：

1. `WAFFO_MODE=test`，`WAFFO_ENABLED=true`，使用 `BILLING_TEST_DB`。
2. Test merchant/store/product ID 与本文一致。
3. Test API private key 和 webhook public key 已通过 Worker secret 配置，值不出现在日志、仓库或聊天。
4. `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 已创建并部署，使用固定 callback；政策确认和外部受众配置已完成。
5. `APP_DB` 应用 `migrations/0001_auth.sql` 和 `migrations/0002_payments.sql`；`BILLING_TEST_DB` 只应用 `migrations/0002_payments.sql`。迁移初始状态应为空；当前已验证状态是 Test 库有 1 次 20 credits 授信，生产库订单、履约和 credits 均为 0。
6. Test checkout 已完成一次；后续重复验收仍只以签名 webhook 和 D1 `paid`/ledger 记录确认授信，不能以 Waffo 完成页面单独代替。

最小只读 D1 查询：

```sql
-- 仅在 APP_DB 执行：
SELECT COUNT(*) AS users FROM users;
SELECT COUNT(*) AS sessions FROM sessions;

-- 在 APP_DB 和 BILLING_TEST_DB 分别执行：
SELECT COUNT(*) AS orders FROM payment_orders;
SELECT COUNT(*) AS fulfillments FROM payment_fulfillments;
SELECT COUNT(*) AS credits FROM credit_ledger;
SELECT order_id, user_id, pack_id, product_id, currency, amount_cents, environment, status, checkout_url, expires_at
FROM payment_orders
ORDER BY created_at DESC
LIMIT 20;
```

浏览器证据边界：旧 Chrome 标签页绑定曾出现 `Emulation.setFocusEmulationEnabled` 超时；2026-11-05 新建 Chrome 标签页可通过 `cua.getAXState`、点击和输入完成实际配置操作。该事实不影响已验证的 Google/Test 结果，也不扩大为生产收款、真钱退款或 AI 已接通。
