# X_watcher

一个可扩展的 X 推文监测 agent 框架。首个场景是关注 `@thsottiaux`：每半小时读取新推文，发现重置相关信息后提醒，并在北京时间每天 **08:00** 整理前一天的内容与其中提到的 ChatGPT 更新。

> **当前 v0.4 已完成 B03 调度与运行模块。** 提供真实 SQLite 和可恢复的常驻宿主；X、模型、邮件仍使用模拟适配器。没有替用户启动后台服务，`preview/live` 仍拒绝启动。模拟内容不代表 Tibo 真实言论。

## 需求与开发顺序

目标产品的完整规则见 [需求文档](docs/REQUIREMENTS.md)，后续实现见 [分块开发计划](docs/DEVELOPMENT_PLAN.md)。两份文档描述未来生产能力，不改变当前纯模拟状态。

开发主线：**领域合同 → SQLite → 可恢复运行 → 真实 X → 分析/重置 → 邮件/核对 → 日报/补报 → 运维/预算 → 部署验收**。下一块是 B04 真实 X 的只读接入与覆盖证明。

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

## 模块

```text
src/
  domain/         模型、端口、时间窗口、校验、错误
  application/    读取分析、每日摘要、通知发送、可插拔规则
  adapters/       模拟数据源、模拟分析、预览通知、内存存储、时钟、日志
  runtime/        单宿主续租、持久化分阶段调度与停止，不依赖 SDK
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
| X / RSS / 其他来源 | `PostSource` | `FixtureSource` |
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
- 数据源必须完成分页并覆盖请求区间；内存合同检查覆盖与待分析状态，真实 API 的覆盖证明在 B04 实现。
- 常驻流程按时区追赶最近 7 个已到期自然日，每轮跨目标最多创建 3 封摘要；覆盖或分析不完整就等待。首次历史提醒过滤已实现；08:15 降级报告、迟到/编辑/删除的报告修订在 B07 实现。
- 邮件 `accepted` 表示供应商接受提交，不代表成功投递。未知结果进入 `needs_attention`，不自动重试。
- “立即提醒”是发现后立即处理，正常轮询发现延迟约 0–30 分钟，服务故障会延长。
- 常驻宿主持久化各阶段下次执行/重试时间，分别安排抓取、分析、投递和日报。旧 `tick()` 仅用于兼容演示；生产部署、健康状态和人工处置 CLI 留到后续阶段。

## 维护

`npm run check` 同时执行严格类型检查与分层依赖检查。GitHub Actions 在 Linux/Windows、Node 22.12/24 上执行 check、test 和三种模拟演示，不调用真实服务。依赖固定并提交 lockfile；升级时走 PR 并通过同样检查。

- [SQLite 持久化、备份与恢复](docs/PERSISTENCE.md)
- [常驻调度、停止与重启恢复](docs/RUNTIME.md)
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
