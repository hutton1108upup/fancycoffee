# 仓库交付清单

本目录是 Fancy Cafe AI 的本地复刻预览。代码已对应 GitHub 仓库 `hutton1108upup/fancycoffee` 的 `main`，Worker 名称为 `fancycoffee`，使用已确认的 Cloudflare 账号 `duckweed`（account ID `7fd7ed1128ca3d125feaa279f4d4c547`）。提交和部署仍按发布授权执行；本文件只说明上传边界。

## 应上传 GitHub 的源码和可复现资源

- 根目录页面与配置：`index.html`、各内容目录下的 `index.html`、`brand.svg`、`manifest.json`、`robots.txt`、`local-server.mjs`、`local-studio.js`、`package.json`、`package-lock.json`、`.gitignore`、`og.png`。
- 本地认证、生成和支付实现及离线测试：`auth/`、`generation/`、`payments/`；Worker 发布实现和迁移：`deploy/`、`migrations/`。
- 网站实际引用的字体和媒体：`fonts/`、`media/`。这些不是忽略项；提交前确认素材和字体的使用授权。
- 页面引用的参考资源：`reference/`。当前真实文件是 `reference/cafe.vtt` 字幕，以及 `reference/keyframes/fancy-cafe-v1/` 下的五张 PNG 关键帧；它们是本项目网页复刻所引用的本地页面资源，不是密钥或运行数据库，按项目资源提交。
- `README.md`、本指南、`.env.example` 和 `.dev.vars.example`。模板只保留空变量名和安全示例，不含真实 secret。

## 只留本地或提交前再决定的文件

- `.env`、任何真实 OAuth secret、私钥、证书、token、导出的账号数据：只留本地，不能上传。
- `.dev.vars`、`.wrangler/` 和 `dist/`：分别是本地 Worker secret、Wrangler 状态和生成的部署产物，只留本地。
- `.data/`、`*.sqlite*`、`*.db*`：运行时数据库、WAL/SHM 和本地状态只留本地；仓库只保留数据库 schema、迁移或不含用户数据的测试 fixture（如果项目另有明确实现）。
- 根目录 `preview-1440.png`、`preview-390.png`：当前是本地验收截图，已在 `.gitignore` 中忽略；需要给评审看时作为单独验收附件提供，确认后再决定是否纳入版本。未来其他目录中的运行资源不会因该规则被误忽略。
- `node_modules/`、日志、coverage、临时导出和操作系统垃圾文件：通过 `.gitignore` 排除，使用 lockfile 在目标环境重新安装。

## 当前状态和边界

GitHub origin 为 `https://github.com/hutton1108upup/fancycoffee`，Worker 名称为 `fancycoffee`；apex/www HTTPS 页面和重定向已有可访问验证。线上 D1 已创建并应用 schema：`APP_DB=fancycoffee-app` 包含用户、OAuth flow、session 和支付表，`BILLING_TEST_DB=fancycoffee-billing-test` 仅含支付表，当前用户、订单和支付记录为 0。Google/Waffo 本项目仍无真实凭据，线上 OAuth 回调和真实收款未验证；AI 仍未接通。

源码仓库和部署产物是两件事：源码、测试、lockfile、`deploy/`、`migrations/` 和可复现的公开资源进入 GitHub；`.env`、`.dev.vars`、运行数据库、用户数据、`.wrangler/`、`dist/` 和本地验收截图只留本地或由平台生成。Node `local-server.mjs` 是本地原型；正式线上代码是 Cloudflare Worker 和 D1，二者不要混用。

## 提交前检查

1. 在项目目录运行 `rg --hidden --no-ignore --files -g '!node_modules/**' -g '!.git/**' -g '*.env' -g '.env.*' -g '*.key' -g '*.pem' -g '*private-key*' -g '*.sqlite*' -g '*.db*'`，确认没有真实凭据或数据库文件进入待提交范围。
2. 运行 `npm install` 或 `npm ci`，确保使用 `package-lock.json` 安装依赖；再运行 `npm test`。
3. 用 `git check-ignore -v` 检查 `.env`、`.data/`、数据库文件、`node_modules/` 和根目录 `/preview-*.png` 的忽略规则；确认 `reference/`、`media/`、`fonts/` 没有被整目录忽略。
4. 检查 `git diff --cached` 或 GitHub 提交预览，确认没有 secret、token、cookie、账号导出或用户数据。发现敏感文件时先停止推送，并区分它处于未提交、已提交但未推送，还是已经公开：分别按当前仓库流程移除、必要时轮换凭据或处理公开暴露；不要自动重写历史，也不要把新增 `.gitignore` 当成清理已跟踪文件的操作。

这些清单由后续 Agent 按当前项目规则执行即可，无需用户逐项代操作；涉及账号、凭据、远程仓库或公开发布时仍须遵守对应授权边界。

