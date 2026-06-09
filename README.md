# 实施项目管家

这是一个 `React + TypeScript + Vite + Tauri + SQLite` 项目管理应用。

## 数据存储

- 浏览器开发/预览模式默认使用 Vite 本地后端写入 SQLite。
- 数据库文件位置：`data/implementation-pm.sqlite`。
- API 路径：`/api/state`，由 `vite.config.ts` 中的本地后端插件提供。
- 应用不再在接口失败时静默回退到浏览器 `localStorage`。
- 如果旧浏览器 `localStorage` 中存在 `implementation_pm:data:v2`，且 SQLite 为空，首次启动会迁移到 SQLite，迁移成功后清除旧 key。
- 顶部导航会显示当前存储后端，例如 `SQLite local DB`。

## 运行

```bash
npm install
npm run dev
```

默认地址固定为：

```text
http://localhost:5174
```

`dev` 和 `preview` 都启用了 `--strictPort`。如果 5174 被占用，服务会直接启动失败，不会自动切换到其他端口。

## 构建

```bash
npm run build
```

单文件预览 `react-standalone.html` 不带 SQLite 后端，不能作为正式数据入口使用。需要持久化项目数据时请使用 `npm run dev` 或 `npm run preview`。

## Tauri 桌面运行

本机需要先安装：

1. Rust / Cargo，建议通过 `rustup` 安装。
2. Visual Studio Build Tools，并包含 MSVC 与 Windows SDK。

运行：

```bash
npm run tauri:dev
```

桌面打包：

```bash
npm run tauri:build
```

桌面端使用 Tauri SQL 插件连接 `sqlite:implementation-pm.db`，数据由 Tauri 存放在应用数据目录下。

## 主要结构

- `src/services/repositoryFactory.ts`：按运行环境选择 SQLite 存储入口。
- `src/services/httpRepository.ts`：浏览器模式通过 `/api/state` 读写本地 SQLite。
- `src/services/sqliteRepository.ts`：Tauri 桌面端 SQLite 存储。
- `src/services/repository.ts`：统一的 `ProjectRepository` 行为和状态迁移逻辑。
- `vite.config.ts`：Vite 本地后端、SQLite 数据库和 AI 代理 API。

## 后续工程重点

1. 将整份 JSON 状态逐步拆分为项目、任务、范围、交付物、风险、周报等规范化 SQLite 表。
2. 将 AI API Key 从页面状态迁移到系统安全存储。
3. 增加数据库备份、恢复和附件本地文件索引。
