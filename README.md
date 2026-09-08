# New API + Antigravity Manager

本仓库包含定制版 New API 和 Antigravity Manager，运行数据、数据库、日志、缓存及本地凭据均不纳入版本控制。

## 快速部署 New API

```bash
cd new-api
cp .env.example .env
# 按需修改 .env 中的数据库、Redis 和 SESSION_SECRET
docker compose up -d --build
```

也可以直接使用 `Dockerfile` 构建镜像。首次启动后访问 `http://localhost:3000` 完成初始化。

如启用 Antigravity OAuth，请在运行环境中自行设置 `ANTIGRAVITY_OAUTH_CLIENT_ID` 和 `ANTIGRAVITY_OAUTH_CLIENT_SECRET`；本仓库不包含任何登录凭证。

## 构建 Antigravity Manager

需要 Node.js 22+ 和 npm 10+：

```bash
cd antigravity-manager
npm ci
npm run type-check
npm run make
```

生成的桌面安装包位于 `out/`。如需无 Electron 的服务模式，可使用仓库中的 `Dockerfile.newapi`。

## 文件说明

`new-api/new-api-full` 和 `new-api/new-api-built` 是 Linux 可执行构建产物，通过 Git LFS 管理；它们不是模型权重。请先安装 Git LFS，再执行 `git lfs pull`。
