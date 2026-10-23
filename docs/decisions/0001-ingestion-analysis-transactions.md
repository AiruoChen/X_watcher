# ADR 0001：抓取与分析分离

状态：B01 内存与 B02 SQLite 均已采用；常驻作业编排在 B03 实现。

## 问题

v0.1 在整批分析成功后才提交抓取数据。模型故障使已取得的正文无法保存，来源和分析服务可用性被绑定，无法直接满足 FR-03/04。

## 决策

- `commitIngestion` 原子保存帖子版本、完整覆盖区间、分析待办和检查点 revision。`recordCoverageGap` 记录缺口但不推进游标。
- `claimAnalysis` 独占领取作业；模型调用在事务外。`commitAnalysis` 原子保存分析结果、规则事件、通知快照和作业完成状态。
- 报告用 `createReportWithNotification` 原子固定来源版本集合和邮件快照。零帖报告记录 empty，不生成邮件。
- `claimDelivery` 同时创建发送 attempt；提交后独立写入 provider_accepted/failed/needs_attention。accepted 不是 delivered。
- 阶段之间通过存储端口的待办衔接。内存实现仅证明合同；它不提供跨进程互斥和重启持久化。

## 标识与版本

领域 ID 使用长度前缀元组，避免分隔符冲突。内容哈希通过 `ContentHasher` 注入，Node 适配器使用 SHA-256。帖子版本键包含来源、稳定作者、帖子和版本；分析作业键追加分析器/提示版本；规则事件键追加规则版本。

保留全部分析版本。`analysisResults(postKey)` 返回历史，`analysisResult(postKey)` 返回最后提交的结果；后续生产报告需明确选定分析/规则版本，不得混用模型升级前后的判断。重分析作业可设置 emitNotifications=false，存储拒绝它提交通知。

供应商可能限制幂等键长度，未来邮件适配器应对内部 ID 做稳定哈希映射并记录幂等有效窗口，不能直接假定所有供应商接收任意长 ID。

## 兼容与限制

`model.ts`、`ports.ts`、`config.ts` 保留作为公开导出入口。旧 `commitPoll/enqueue/claim/finish` 仅供 v0.1 调用者过渡；新流程不调用旧提交函数。新增配置字段及 PollTarget/DailyDigest 的构造参数属于 0.2 接口演进，调用者应通过 bootstrap 注入。

B01 只连接单次模拟流程。独立队列唤醒、持久化退避、超时/崩溃恢复、实际 X 作者 ID 解析、完整生产时间解析和真实邮件均仍待实施。

## 验证

`tests/contracts/watch-store.contract.ts` 可直接用于 B02 的 SQLiteStore。覆盖原子写入、revision、缺口、身份固定、领取互斥、重试时间、通知不可变、报告去重、版本重分析及未知发送不重发。
