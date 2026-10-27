# SQLite 持久化

当前 v0.8 / schema 6 新增 source_observations、report_progress 和 report_boundaries，保存最近查询时间、日报等待/事故去重状态和紧凑的历史跳过区间。覆盖记录保存可选的成功补查时刻；新报告沿用 digest_reports 表，额外固定帖子/分析版本、父报告、变更集合、正文及哈希。

报告在同步事务中重验输入并与 outbox 同时提交，渲染/来源查询/分析均在事务外；只读快照通过 SQLite 读事务保持一致。1–5 的迁移及校验和不变，5→6 升级前生成并验证备份，不重建原库或改写旧通知。无证明的旧覆盖需重新补查。详见 [REPORTING.md](REPORTING.md)。

以下 B02/B03 说明为早期持久化设计与既有能力。

v0.5/B04 仍使用 schema 3：通过可选 JSON 字段保存来源/编辑/引用元数据、公开索引覆盖 scope，以及持久化供应商等待时间；无表删除、旧数据重建或隐式身份替换。当前可显式启用 X 只读 preview，账户联调未执行；后文 B02/B03 外部模拟状态为历史说明，实际接入见 [X 说明](integrations/x.md)。

B02 提供真实本地持久化，B03 已组装常驻宿主、独立阶段调度和停止/重启编排；X、模型与邮件仍模拟，不会自动启用 live。入口与边界见 [RUNTIME.md](RUNTIME.md)。

## 使用

```sh
npm ci
npm run check
npm test
npm run demo
npm run storage:demo
npm run storage:bench
```

Node 22.12 的 SQLite 需要 `--experimental-sqlite`，相关 npm 命令已包含。`storage:demo` 只使用合成推文、固定时钟和邮件预览：创建临时 SQLite，完成一次摘要，关闭后重新打开并证明未重复通知，最后清理自身临时目录。它不读取真实密钥，也不发送邮件。

`storage:bench` 在临时目录构造 10 个目标、10 万条合成版本/分析记录，报告机器规格、写入时间、查询时间和查询计划；没有时间阈值断言，仅验证返回 24 条日窗口记录、空待办队列和命中索引。见 [容量记录](benchmarks/sqlite-100k.md)。

```ts
import { SqliteStore } from '../src/adapters/storage/sqlite/store.js';
import { restoreBackup } from '../src/adapters/storage/sqlite/backup.js';

const store = new SqliteStore('data/watcher.sqlite', { create: true });
// 通过 B01 的 WatchStore 端口执行业务；所有网络调用在事务外。
const manifest = store.backup('data/backup-001.sqlite');
store.close();

const reopened = new SqliteStore('data/watcher.sqlite'); // 不存在则报错
reopened.close();
restoreBackup('data/backup-001.sqlite', 'data/restored.sqlite', manifest.sha256);
```

`create:true` 只允许创建**尚不存在**的新文件；现有零字节、损坏文件、未知 schema、篡改迁移历史或缺失必需对象都会拒绝打开，不自动重建空库。新建失败可能保留未完成文件，应保留诊断并显式处理，不能靠循环 create 掩盖问题。

默认 `npm start` 保留一次性模拟演示；`npm run watch` 才是 SQLite 常驻前台入口。不能因为配置 STORAGE_KIND=sqlite 就认为已有生产后台运行。

## 表、版本与迁移

- Schema 1 建立 targets、checkpoints、coverage_ranges、post_versions、analysis_jobs、analysis_results、rule_events、digest_reports、notifications、delivery_attempts、runtime_ownership、audit_events，以及兼容的 legacy_posts。
- Schema 2 记录作业/尝试领取者，并增加按目标/日期、最新版本、作业状态、结果版本、通知状态和尝试的索引，数据保持不变。
- Schema 3 增加 runtime_tasks 及状态/期限索引，保存分阶段下次执行、失败次数、领取状态与 revision；通知增加 reset/correction 优先表达式索引，已有业务记录不变。
- `schema_migrations` 记录有序版本与 SQL 校验和，`PRAGMA user_version` 与历史必须一致；未知未来版本拒绝写入。
- 迁移在单个同步事务中执行，失败同时回滚 DDL、历史和业务数据。对已有旧库升级前先生成经过完整性校验的 `.pre-vN.<随机值>.sqlite` 备份。
- 启动检查 SQLite quick_check、外键、迁移历史、必需表和当前版本索引。不会用 IF NOT EXISTS 给损坏的现有库补空表掩盖问题。

每条领域记录独立保存 JSON 快照，并将查询键、时间、状态、revision 置于可索引列；不是整库序列化成一个 JSON。输入和返回值不与存储共享可变对象。源内容只存在于私密数据库，普通日志不输出正文/收件人/密钥。

## 事务合同

所有写入使用 `BEGIN IMMEDIATE`，启用 foreign_keys、WAL、synchronous=FULL 和有限 busy_timeout。事务只包含同步数据库和纯校验计算，不等待网络。事务工具在执行前拒绝 async 回调，并拒绝 thenable 结果。

- 抓取：帖子版本、覆盖、分析作业和 checkpoint revision 一起提交；旧 revision 冲突不留下部分数据。
- 分析：结果、规则事件、通知和作业完成状态一起提交；失败作业保留待办。
- 报告：来源版本集合、报告和通知一起创建；已存在的报告不覆盖原收件人或内容。
- 发送：pending → sending 与 attempt 原子建立；结果单独落盘。accepted 只标记 provider_accepted，不是 delivered。
- 恢复：打开连接不会修改 processing/sending；显式恢复将未决发送隔离到 needs_attention，不重新排队。

旧 `commitPoll` 仅兼容已注册目标的 v0.1 数据，保存在 legacy_posts；新流程使用分离后的事务端口，不猜测/创建真实作者身份。

## 执行权与围栏

`store.runtime` 实现领域 `RuntimeLeaseControl`；运行宿主必须先 acquire，然后续租并在所有在途工作落盘后 release。连接数据库本身不等于取得任务执行权。无宿主时仍允许显式的底层存储/维护操作，供初始化、测试和后续 CLI 使用；这不是生产宿主入口。

```ts
const lease = store.runtime.acquire(30_000);
if (!lease) throw new Error('Another host owns this database');
// 任务通过 store 执行，写事务会重验当前 owner/revision/有效期。
const renewed = store.runtime.renew(lease.revision, 30_000);
store.runtime.release(renewed.revision);
```

- owner 标识、主机、PID、递增 revision 和期限持久化；释放后 revision 不重置，避免旧 token 再次生效。
- 已有 owner 时，其他连接不能领取/提交业务写入；失去执行权的旧连接也不能续租或提交结果。即使没有宿主，连接也不能完成其他 worker 领取的作业/发送尝试。
- 超时本身不证明进程死亡。只允许对**同主机、已过期、明确进程已死**的 owner 进行替换；未知存活状态或其他主机一律拒绝。
- OS 存活探测在事务外执行，事务内重验之前观察到的执行权 revision，防止探测期间执行权已变化。
- close 不会释放运行执行权。release 在存在 processing/sending 或 running 阶段标记时拒绝执行。当前连接租约有效期使用单调时间，墙钟期限仍持久化用于死进程替换；两者均重验 owner/revision。
- 取得新执行权后，显式 `recoverAbandonedWork(revision)` 将其他领取者遗留的 processing 分析与 sending 通知隔离，记录审计；当前领取者仍在执行的工作不被恢复流程改写；不自动释放/重发。B03 宿主已调用该接口，再恢复阶段标记；人工重排与供应商核对由后续阶段实现。
- 保留的 `recoverInFlight()` 是显式兼容操作，只隔离 sending；B03 宿主应使用带执行权的 recoverAbandonedWork。

本实现保守处理 PID 复用：若 PID 活着，就不当成已死亡进程。恢复到另一主机时保留原执行权和未决记录，不自动消除旧主机状态；跨主机人工处置入口留给后续阶段。

## 备份与恢复

`backup(destination)` 使用 VACUUM INTO 生成包含已提交 WAL 数据的一致快照，校验数据库、计算 SHA-256 并 fsync 文件。临时文件在目标同目录中生成，使用原子、禁止覆盖的硬链接发布，再清理临时名。返回 schemaVersion、sha256、bytes；调用者应把 manifest 保存到受保护的位置，B08 增加操作命令和管理界面。

`restoreBackup(source, newDestination, expectedSha256)` 先核对源校验和和完整性，复制到临时文件，再复核哈希/数据库并发布到**新路径**。既有数据库、备份及其 WAL 不会被覆盖。恢复出来的 sending 仍是 sending，必须核对或显式隔离，不能认为从备份恢复就等于邮件没发过。

当前要求支持硬链接的本地文件系统和相应权限。权限/文件系统不支持时失败并保留原库，不降级为可能覆盖旧文件的写法。文件内容已同步，但不承诺所有硬件/文件系统断电场景的目录项持久性。Windows 限制沙箱可能阻止硬链接；正常权限和 CI 验证覆盖 NTFS/Linux runner。

自动升级前的快照仍保留旧 schema。恢复该快照到新路径后，正常打开会走相同的有备份迁移流程。

## 验证范围

两种存储运行同一套合同测试；额外覆盖：跨进程争抢、双连接 revision 冲突、进程强制终止时回滚、未知/坏库拒启、失败迁移、旧库升级、篡改历史、缺失索引、执行权续期/失效/探测竞争、显式恢复、备份哈希和禁止覆盖。

正常读取增加按版本键、日期窗口和待办分页的端口；IngestTarget、ProcessAnalysis、DailyDigest 和投递用例不再请求全部历史版本/通知。`versions/outbox` 等历史列表保留用于显式诊断，不能作为生产队列轮询接口。

## 协议核对

实现使用本机 Node v22.12.0 与 SQLite 3.47.0 验证；未使用更高版本才提供的异步备份 API。

- [Node 22.12 SQLite](https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html)：DatabaseSync 与特性开关。
- [SQLite 事务](https://www.sqlite.org/lang_transaction.html)：单写者、IMMEDIATE 事务和回滚。
- [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)：在线一致备份和输出文件要求。

## RSSHub 快照（v0.6）

Schema 仍为 3，不迁移/丢弃旧数据。commitIngestion 允许 RSSHub 专属 scope、gap 和未验证原因 rsshub_snapshot_unverified，与帖子、观察检查点、待分析作业在同一事务提交。gap 不参与 isCovered，因此成功快照不冒充完整一天。推荐独立 rsshub-preview 库；旧作者/官方游标不重写，回退使用旧库或已验证备份。

## v0.7 / schema 4

新增 notifications.revision 和按通知查询邮件审计的索引。旧快照、尝试和未知状态原样保留，迁移前备份。claim/finish/recovery/resolve 都递增 revision；resolve 的比较、状态和 audit_events 在同一事务完成。attempt.binding 保存供应商/账号/发件人/幂等键/到期时间/次数上限，旧无 binding 记录不能自动补猜查询身份。原始发送尝试结果不会被人工处理覆盖。deliveryRecord 在单个 SQL 查询内读取状态、revision 与最新尝试。

## v0.7.1 / schema 5

新增 notifications.next_delivery_ms 与 notification_retry_due 索引，旧通知、发送尝试及待核对状态原样保留。只有明确未接收且可重试的结果能进入 retry_wait；attempt 结果、通知状态、nextAttemptAt 和 revision 在同一事务保存。队列查询与领取都验证到期时间，领取时清除期限；异常恢复将已领取的发送标为未知而非重新排队。绑定中保存的重试策略、账号和幂等期限不随当前配置变化。没有可证明策略/期限的旧记录不自动消费。

更正分析的 correctionLink、规则事件和通知 supersedesPostKey 同事务保存，关联只允许同来源/目标/作者、已存在且排在当前版本之前的记录；不能用模型提供的本地键或未来版本冒充前驱。旧不可变快照不覆盖，数据清理阶段须保留这些关联依赖。
