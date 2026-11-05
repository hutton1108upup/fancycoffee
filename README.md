# Fancy Cafe AI 本地复刻预览

本目录是根据原站公开页面保存的静态预览，共 15 个页面，并非原项目源码或可上线成品。图片、视频和字体保存在本地。原页面中的域名已替换为 https://fancycafeaivideo.pro，客服邮箱暂未配置。

## 本地查看

在本目录打开 PowerShell，运行本地服务（会提供页面和未配置状态的安全 API）：

```powershell
npm start
```

浏览器访问 http://127.0.0.1:8766/ 。按 Ctrl+C 停止服务。若 8766 也被占用，可运行 `$env:PORT='8876'; node local-server.mjs` 后访问对应端口。

## Google 登录本地接入

登录路由已经接入，但只有配置真实 Google OAuth 客户端后才会跳转到 Google；没有配置时 `/auth/google/start` 返回 `503 AUTH_CONFIGURATION_MISSING`，不会伪造登录。

先在编辑器中复制 `.env.example` 为 `.env`，再只在 `.env` 文件中填写 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` 和 `GOOGLE_REDIRECT_URI`；不要把 secret 粘贴到聊天窗口或终端命令中。然后在项目目录运行：

```powershell
npm start
```

`npm start` 会使用 Node 24 的 `--env-file-if-exists=.env` 自动加载本地配置。

本地路由：`GET /auth/google/start`、`GET /auth/google/callback`、`GET /auth/me`、`POST /auth/logout`。流程使用 `state`、`nonce`、S256 PKCE 和 HttpOnly SameSite 会话 Cookie；本地会话存于进程内，重启服务会清除。不要把 `.env` 提交到 Git。当前只完成本地路由和离线 mock 验证，真实 Google 账号、线上回调和生产 HTTPS 尚未验证。支付模块也只完成本地边界与离线测试，未接 HTTP 实际收款；运行数据应放在被忽略的 `.data/` 私有目录中。

## 尚未接入

AI 图片/视频生成、积分、历史记录、客服和服务端存储均未配置，相关控件已停用；Google 登录和支付仅完成本地可配置边界，未完成真实账号、线上回调或实际收款验证。页面内原站价格、服务说明、隐私条款、退款政策及参考视频仅供复刻核对，不能作为新站的真实承诺。上线前须按实际配置和素材授权逐项核实并更新。当前页面设置了 noindex，robots.txt 禁止抓取；上线前需根据准备情况重新处理。

仓库上传与本地保留清单见 [`REPOSITORY_GUIDE.md`](REPOSITORY_GUIDE.md)。

## 发布说明

当前 GitHub 仓库为 [hutton1108upup/fancycoffee](https://github.com/hutton1108upup/fancycoffee)，线上域名为 [fancycafeaivideo.pro](https://fancycafeaivideo.pro)。Cloudflare Worker 采用手动 CLI 发布，不是 Git push 自动部署；发布前按顺序执行 `npm ci`、`npm test`、`npm run build`，再由已确认的发布身份执行 `npx wrangler deploy`。发布后检查 `/release.json`，将其中 `gitSha` 与 `main` 的实际提交核对；当前构建在无有效提交时会记录 `unknown`，不会伪造 SHA。站点保持 `noindex`，provider 仍未配置；HTTPS 页面已可访问，但线上 Google OAuth 回调和真实 provider 仍未验证。
