# 领域模型与端口（B01 基线）

B02 已提供真实 SQLite、运行执行权、备份与合同验证；当前落地情况见 [持久化说明](PERSISTENCE.md)。下文以领域设计为主。

`src/domain/model.ts` 与 `ports.ts` 是兼容导出入口。领域模型拆入 `models/`，策略在 `policies/`，工作流存储合同位于 `ports/store.ts`。领域层无 Node 或供应商依赖。

| 模型 | 责任 |
| --- | --- |
| TargetIdentity | 稳定作者 ID、展示账号、监测起点与配置版本；重新注册不能静默换人/重置起点 |
| PostVersion | 来源/作者/帖子/版本、内容哈希、原始/发现时间、完整性/删除状态 |
| Coverage | 时间区间和 complete/gap；查询成功时刻本身不能证明覆盖完整 |
| AnalysisJob / Result | 可领取待办、revision、尝试次数、分析器/提示版本、完整结果历史 |
| ProductUpdate / ResetFinding | 产品和发布状态、明确/讨论/更正、原文证据、可证明的时间 |
| RuleEvent | 帖子版本与规则版本绑定的唯一事件 |
| DigestReport | 日期/时区、来源版本集合、状态、配置版本和内容哈希 |
| Notification / DeliveryAttempt | 不可变内容和收件人、每次提交、供应商结果，与报告状态独立 |
| RuntimeOwnership / AuditRecord | 执行权与审计数据合同；B02 已实现数据库租约/领取者围栏，宿主编排和人工核对在 B03/B06 |

## 状态与校验

- 分析 pending/retry_wait → processing → completed/retry_wait/needs_attention。终态不能被自动领取。
- 发送 pending → sending → provider_accepted/failed/needs_attention。只有独立回执才可从 provider_accepted 进入 delivered/bounced；回执消费在 B06 实现。
- 报告 awaiting_data/awaiting_analysis → ready/empty，旧快照可被标记 superseded。当前参考实现只原子创建 ready/empty；报告修订在 B07 实现。
- `needs_attention` 的自动重发被禁止。人工处置和供应商重试状态的执行在 B06 实现。
- 时间必须是日历有效、带时区的 ISO 时刻；原文时间不明确时保持 null。

运行时分析验证覆盖字段类型、长度、枚举和原文证据。B01 仅允许以原文中的明确 ISO 时刻作为 normalizedAt 的转换依据；“明天”不能凭模型变成精确 UTC。其他日期语义解析留给 B05。

## 事务合同

1. `commitIngestion`：完整帖子/覆盖/分析待办/检查点一起提交。
2. `commitAnalysis`：结果/规则事件/通知/完成状态一起提交。
3. `createReportWithNotification`：来源集合/报告/通知一起创建；重复不覆盖旧收件人或正文。
4. `claimDelivery/finishDelivery`：唯一 attempt 区分提交前后；未知结果不能变回 pending。

内存存储返回深拷贝；输入冲突或无效时不部分发布状态。旧 `commitPoll` 标为 deprecated，仅用于过渡。共享合同测试已同时通过 MemoryStore 和 SQLiteStore。

## 当前运行边界

B04 已增加官方 X 只读来源，实际账号联调待 Token 配置，模型/通知仍未真实接入。Post.origin 可选保存来源作者、当前响应 ID、版本、编辑历史、original/reply/quote/repost、完整性和独立引用上下文。真实版本结合响应 ID 与内容哈希，编辑历史首 ID 归并逻辑帖子；未知删除不猜测。旧模拟版本仍使用原文本/时间/URL 哈希，不改旧键或模拟身份。

PostBatch.coverage 可显式向前重叠，结束点必须匹配固定查询；Coverage.scope=x_recent_public_index 表示公开搜索索引的范围，不等于全部历史。SourceCoverageGap 记录不可查询日期，SourceFailure 只传白名单代码、是否可重试和可选等待时间。调度保存 failureCode/retryNotBeforeAt；重启不缩短供应商硬等待。更多协议边界见 [X 接入说明](integrations/x.md)。

单次 demo 连接各阶段；常驻独立调度、跨进程执行权、停止恢复和全局重试唤醒仍属于 B02/B03。B02 的 SQLite 租约与领取者围栏已验证跨进程互斥；运行宿主仍须在 B03 显式组装和续租，不能仅凭构造 Store 就宣称后台服务已获得执行权。

## RSSHub 合同增量（v0.6）

Post.origin / PostVersion.completeness 新增 unknown，kind 新增 unknown。PostBatch.complete 只描述该响应是否读完，coverageStatus=unverified 与 scope=rsshub_timeline_snapshot 必须同时出现；摄取原子保存 gap（reason=rsshub_snapshot_unverified）及观察检查点，不能证明时间覆盖。存储仅允许这个明确组合在摄取事务中写 gap，旧官方完整查询合同不变。目标/作者使用独立 RSSHub handle 身份，不声称数字 X ID；schema 保持 3。详细边界见 [RSSHub 指南](integrations/rsshub.md)。
