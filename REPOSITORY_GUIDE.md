# 仓库交付清单

本目录是 Fancy Cafe AI 的本地复刻预览。提交 GitHub 时按下面的边界整理文件；本文件只说明上传边界，不执行 Git 初始化、提交、推送或部署。

## 应上传 GitHub 的源码和可复现资源

- 根目录页面与配置：`index.html`、各内容目录下的 `index.html`、`brand.svg`、`manifest.json`、`robots.txt`、`local-server.mjs`、`local-studio.js`、`package.json`、`package-lock.json`、`.gitignore`、`og.png`。
- 本地认证、生成和支付实现及离线测试：`auth/`、`generation/`、`payments/`。
- 网站实际引用的字体和媒体：`fonts/`、`media/`。这些不是忽略项；提交前确认素材和字体的使用授权。
- 页面引用的参考资源：`reference/`。当前真实文件是 `reference/cafe.vtt` 字幕，以及 `reference/keyframes/fancy-cafe-v1/` 下的五张 PNG 关键帧；它们是本项目网页复刻所引用的本地页面资源，不是密钥或运行数据库，按项目资源提交。
- `README.md`、本指南和 `.env.example`。`.env.example` 只保留空变量名和安全的本地回调示例。

## 只留本地或提交前再决定的文件

- `.env`、任何真实 OAuth secret、私钥、证书、token、导出的账号数据：只留本地，不能上传。
- `.data/`、`*.sqlite*`、`*.db*`：运行时数据库、WAL/SHM 和本地状态只留本地；仓库只保留数据库 schema、迁移或不含用户数据的测试 fixture（如果项目另有明确实现）。
- 根目录 `preview-1440.png`、`preview-390.png`：当前是本地验收截图，已在 `.gitignore` 中忽略；需要给评审看时作为单独验收附件提供，确认后再决定是否纳入版本。未来其他目录中的运行资源不会因该规则被误忽略。
- `node_modules/`、日志、coverage、临时导出和操作系统垃圾文件：通过 `.gitignore` 排除，使用 lockfile 在目标环境重新安装。

## 当前状态和边界

这是本地可审查版本，不代表 GitHub 已创建、代码已提交、部署已上线或真实外部服务已验证。Google 登录目前有可配置的本地 OAuth 路由和离线 mock 测试，真实 Google 账号、线上回调、生产 HTTPS 尚未验证。生成 provider、支付 HTTP 实际收款、账号数据持久化和部署也未作为已上线能力声明。

源码仓库和部署产物是两件事：源码、测试、lockfile 和可复现的公开资源进入 GitHub；`.env`、运行数据库、用户数据、构建缓存和本地验收截图不自动进入部署。部署前应由部署平台单独配置 secret 和运行数据目录。

## 提交前检查

1. 在项目目录运行 `rg --hidden --no-ignore --files -g '!node_modules/**' -g '!.git/**' -g '*.env' -g '.env.*' -g '*.key' -g '*.pem' -g '*private-key*' -g '*.sqlite*' -g '*.db*'`，确认没有真实凭据或数据库文件进入待提交范围。
2. 运行 `npm install` 或 `npm ci`，确保使用 `package-lock.json` 安装依赖；再运行 `npm test`。
3. 用 `git check-ignore -v` 检查 `.env`、`.data/`、数据库文件、`node_modules/` 和根目录 `/preview-*.png` 的忽略规则；确认 `reference/`、`media/`、`fonts/` 没有被整目录忽略。
4. 检查 `git diff --cached` 或 GitHub 提交预览，确认没有 secret、token、cookie、账号导出或用户数据。发现敏感文件时先停止推送，并区分它处于未提交、已提交但未推送，还是已经公开：分别按当前仓库流程移除、必要时轮换凭据或处理公开暴露；不要自动重写历史，也不要把新增 `.gitignore` 当成清理已跟踪文件的操作。

这些清单由后续 Agent 按当前项目规则执行即可，无需用户逐项代操作；涉及账号、凭据、远程仓库或公开发布时仍须遵守对应授权边界。

