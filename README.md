# X_watcher

一个可扩展的 X 推文监测 agent 框架。首个场景是关注 `@thsottiaux`：每半小时读取新推文，发现重置相关信息后提醒，并在北京时间每天 **08:00** 整理前一天的内容与其中提到的 ChatGPT 更新。

> **当前 v0.7 已完成 B05/B06 可配置接口和离线验证。** 包含结构化分析、重置证据/时间规则、邮件尝试、只读核对、人工处理及 SQLite schema 4。按你的选择，暂不指定模型或邮件服务商，不进行真实分析或发信。运行 `npm run modules:demo` 查看完整离线流程；接口见 [分析模块](docs/integrations/analysis.md) 和 [邮件模块](docs/integrations/mail.md)。

> **v0.6 已新增自托管 RSSHub 来源。** 推荐入口为 `rsshub:probe` / `rsshub:preview`；它读取有限 JSON Feed 快照并保存到 SQLite，不调用本项目的官方 X API。模型/邮件的真实客户端尚未接入；当前不会发送摘要或提醒。Docker 与真实 Cookie 联调尚未执行，配置与部署见 [RSSHub 指南](docs/integrations/rsshub.md)。

> **v0.5 已完成 B04 X 只读接入代码与合成验证。** 官方 X API 可通过显式 `x:probe` / `x:preview` 入口接入；用户凭据稍后本地配置，真实账号联调尚未执行。模型/邮件尚未接入，`live` 继续拒绝启动；没有替用户启动后台服务。demo/test/CI 不访问真实服务。

## 需求与开发顺序

目标产品的完整规则见 [需求文档](docs/REQUIREMENTS.md)，后续实现见 [分块开发计划](docs/DEVELOPMENT_PLAN.md)。两份文档描述未来生产能力；当前提供模拟演示及显式真实只读入口，尚未形成分析/发信闭环。

开发主线：**领域合同 → SQLite → 可恢复运行 → 真实 X → 分析/重置 → 邮件/核对 → 日报/补报 → 运维/预算 → 部署验收**。B05/B06 通用接口已完成，服务商接入与真实验收待后续确定；下一业务块为 B07 日报/补报。RSSHub 的真实核验需先启动自托管实例并配置登录 Cookie；官方 API 方案的 Token 联调仍可独立进行。

## 快速开始

需要 Node.js 22.12+。

```sh
npm ci
npm run check
npm test
npm run demo
npm run config:check
npm run storage:demo
npm run runtime:demo
```

演示使用固定时钟、虚构历史/新推文、内存存储及邮件预览，运行两次 tick 验证同一进程中不会重复通知。没有网络请求，不需要 API 密钥。

复制 `.env.example` 为 `.env`，可调整监测账号、轮询间隔、时区、摘要时间、收件人。然后运行 `npm start` 读取配置并执行一次模拟演示；它会退出，**不是常驻服务**。在当前演示中，日期固定为 2026-01-02，北京时间 08:00，因此其他时区/摘要时间可能尚未到点。真实邮箱仅保存在忽略的 `.env` 中。

运行常驻模拟宿主：在 `.env` 中设置 `APP_MODE=demo`、`STORAGE_KIND=sqlite`，首次执行 `npm run watch -- --create`；后续执行 `npm run watch`。它使用系统时钟、真实 SQLite 和空模拟来源，只生成空报告状态，不读取 X、不发邮件；按 Ctrl+C 优雅停止。新库必须显式创建，坏库不会被覆盖。`runtime:demo` 则使用虚构帖子和虚拟时钟，自动验证启动、停止、重新打开及摘要预览去重后退出。详见 [运行模块](docs/RUNTIME.md)。

## 自托管 RSSHub（当前选择）

1. 安装并启动 Docker Desktop（Linux containers）；复制 `deploy/rsshub/.env.example` 为同目录 `.env`，填写 X 网站登录 Cookie 中的 `auth_token` 值，即 `TWITTER_AUTH_TOKEN`。这与 X API Bearer Token 不同。
2. 在项目根目录执行：

```powershell
docker compose --env-file deploy/rsshub/.env -f deploy/rsshub/compose.yaml up -d
```

3. 根目录 `.env` 设置以下读取配置（保留已有账号/时区/收件人）：

```dotenv
APP_MODE=preview
STORAGE_KIND=sqlite
DATABASE_PATH=data/rsshub-preview.sqlite
SOURCE_PROVIDER=rsshub
SOURCE_CREDENTIAL_ENV=
RSSHUB_BASE_URL=http://127.0.0.1:1200
ANALYSIS_PROVIDER=deferred
ANALYSIS_CREDENTIAL_ENV=
ANALYSIS_MODEL=
```

4. 检查配置、探测；第一次显式创建独立数据库：

```powershell
npm run config:check
npm run rsshub:probe
npm run rsshub:preview -- --create --once
# 后续运行半小时轮询，Ctrl+C 停止
npm run rsshub:preview
```

Cookie 只在 RSSHub 中使用，应用不读取或转发它。RSSHub 缓存/限流可能增加发现延迟；订阅只保留有限条目，无法保证历史无遗漏。抓取结果以未验证覆盖保存，不伪装成完整日报。正文完整性未知的作业保留待办，B05 已提供显式部分正文分析策略；B07 仍需实现降级日报。详细修改点、凭据位置和排障见 [RSSHub 接入与迁移](docs/integrations/rsshub.md)。

## 官方 X 只读入口（可选）

在忽略的 `.env` 中设置 `APP_MODE=preview`、`STORAGE_KIND=sqlite`、`DATABASE_PATH=data/x-preview.sqlite`、`SOURCE_PROVIDER=x-api-v2`、`SOURCE_CREDENTIAL_ENV=X_BEARER_TOKEN`、`ANALYSIS_PROVIDER=deferred`，保持分析模型/凭据为空。真实 Token 只放本地环境变量或忽略的 `.env`。

```sh
npm run x:probe
npm run x:preview -- --create --once
npm run x:preview
```

先探测，再创建独立 preview 库。探测不打开数据库；preview 保存真实帖子/范围/待分析作业，复用常驻调度，**不分析、不生成日报、不发邮件**。这些显式命令会访问官方 API，可能计费。超出可查询范围就记录 gap，不能假装历史完整。实际权限、ID 查询、字段版本与余额仍待账号联调；详见 [X 接入说明](docs/integrations/x.md)。

## 模块

```text
src/
  domain/         模型、端口、时间窗口、校验、错误
  application/    读取分析、每日摘要、通知发送、可插拔规则
  adapters/       模拟数据源、模拟分析、预览通知、内存存储、时钟、日志
  runtime/        单宿主续租、持久化分阶段调度与停止，不依赖 SDK
  bootstrap-source.ts  按 SOURCE_PROVIDER 选择真实读取适配器
  source-preview.ts    复用探测与只读常驻流程
  bootstrap.ts    依赖组装与运行模式校验
  bootstrap-runtime.ts  常驻流程组装
  config.ts       环境变量校验
  cli.ts          命令入口
  demo.ts         安全的端到端模拟
scripts/          分层依赖检查
tests/           行为测试（无真实服务）
docs/             架构、接口扩展指南、路线图
```

| 扩展点 | 接口 | 首版实现 |
| --- | --- | --- |
| X / RSS / 其他来源 | `PostSource` | `FixtureSource` / `RsshubSource` / `XSource`（只读 preview） |
| LLM / 本地分析 | `ContentAnalyzer` | `FixtureAnalyzer` |
| 邮件 / Webhook / 其他通知 | `NotificationChannel` | `PreviewChannel` |
| SQLite / 其他数据库 | `WatchStore` | `MemoryStore` / `SqliteStore` |
| 关键词 / 重置 / 其他规则 | `NotificationRule` | `ResetRule` |
| 摘要排版 | `DigestRenderer` | `TextDigestRenderer` |
| 测试时间 / 系统时间 | `Clock` | `ManualClock` / `SystemClock` |
| 日志 / 指标 | `EventSink` | `ConsoleEvents` |

调度器对每个目标按配置间隔发起查询；同一实例并发 tick 合并执行。完整查询先原子保存帖子、覆盖区间、分析待办和游标，再独立保存分析结果与规则通知。分析失败不丢掉抓取数据。重置提醒优先进入发送流程；每日摘要在当地 08:00 之后生成，覆盖前一天 `[00:00, 次日 00:00)`。完整覆盖且零帖时记录 empty，不发送空摘要。首次回溯的历史帖子只参与日报，不触发即时重置提醒。

每条摘要附来源链接。重置提醒保留原文时间和时区；原文没有写清楚就显示未知，不推算用户实际账户额度。ChatGPT 更新只是该账号推文中提及的内容，不等同于已核实的官方更新全集。

## 首版边界

- 已提供 SQLite 存储、迁移、执行权和备份恢复 API；`watch` 是前台常驻模拟入口，`npm start` 保留单次演示。
- 官方 API 数据源必须完成分页并覆盖请求区间；RSSHub 只承诺读完当前响应，时间覆盖始终未验证。B04 明确保存公开 Recent Search 的覆盖范围；历史缺口、字段/权限错误和部分失败不推进检查点，真实账户范围仍待验证。
- 常驻流程按时区追赶最近 7 个已到期自然日，每轮跨目标最多创建 3 封摘要；覆盖或分析不完整就等待。首次历史提醒过滤已实现；08:15 降级报告、迟到/编辑/删除的报告修订在 B07 实现。
- 邮件 `accepted` 表示供应商接受提交，不代表成功投递。未知结果进入 `needs_attention`，不自动重试。
- “立即提醒”是发现后立即处理，正常轮询发现延迟约 0–30 分钟，服务故障会延长。
- 常驻宿主持久化各阶段下次执行/重试时间，分别安排抓取、分析、投递和日报。旧 `tick()` 仅用于兼容演示；生产部署、健康状态和人工处置 CLI 留到后续阶段。

## 维护

`npm run check` 同时执行严格类型检查与分层依赖检查。GitHub Actions 在 Linux/Windows、Node 22.12/24 上执行 check、test 和三种模拟演示，不调用真实服务。依赖固定并提交 lockfile；升级时走 PR 并通过同样检查。

- [SQLite 持久化、备份与恢复](docs/PERSISTENCE.md)
- [常驻调度、停止与重启恢复](docs/RUNTIME.md)
- [RSSHub 自托管、配置与修改清单](docs/integrations/rsshub.md)
- [X 官方 API、配置与真实核验边界](docs/integrations/x.md)
- [合成容量验证](docs/benchmarks/sqlite-100k.md)
- [领域模型与事务合同](docs/DOMAIN_MODEL.md)
- [配置字段与校验规则](docs/CONFIGURATION.md)
- [抓取/分析分离决策](docs/decisions/0001-ingestion-analysis-transactions.md)
- [完整产品需求与验收矩阵](docs/REQUIREMENTS.md)
- [分块开发顺序与完成条件](docs/DEVELOPMENT_PLAN.md)
- [架构与一致性约定](docs/ARCHITECTURE.md)
- [如何添加功能](docs/EXTENDING.md)
- [分阶段路线图](docs/ROADMAP.md)
- [项目开发规则](AGENTS.md)
