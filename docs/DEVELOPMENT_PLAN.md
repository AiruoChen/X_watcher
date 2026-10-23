# X_watcher 分块开发计划

版本：1.0 · 2026-10-23 · 配套需求：[REQUIREMENTS.md](REQUIREMENTS.md)。

本计划描述实施顺序；B01 已于 v0.2 完成模型、配置和内存合同，B02 及后续生产能力仍待实现。v0.1 初始基线包含 17 项测试；当前 v0.2/B01 已扩展为 43 项测试，类型检查、分层检查和 demo 已在本地通过。跨平台结果以本次 CI 为准。

## 1. 总体顺序

**领域合同与配置 → 持久化 → 可恢复的模拟流程 → 真实 X 读取 → 分析与重置判定 → 真实邮件与核对 → 日报与补报 → 运维和预算 → 部署验收 → 可选扩展。**

先确定数据和事务边界，避免接入真实服务后再重写数据库。真实发送晚于持久化与恢复，管理界面晚于核心服务。每块独立提交并通过门槛再进入下块；不按“先写完所有文件再整体测试”的方式推进。

| 块 | 交付物 | 前置依赖 | 需求覆盖 | 能力等级 |
| --- | --- | --- | --- | --- |
| B00 | 模块化模拟框架 | 无 | 原型验证 | 已完成、纯模拟 |
| B01 | 领域合同、状态机、配置 schema、架构决策 | B00 | FR-01/03/05/09 | 设计 + 模拟 |
| B02 | SQLite、迁移、待办/outbox、执行权与契约测试 | B01 | FR-03/09/10、NFR-02/04 | 本地真实持久化 |
| B03 | 抓取/分析/发送分离、常驻宿主、恢复和调度 | B02 | FR-03/08/10 | 外部服务仍模拟 |
| B04 | 真实 X 来源和只读探测 | B03 | FR-02/03 | 真实读取、禁止真实发信 |
| B05 | 分析适配器、重置语义与证据/时间校验 | B04 | FR-04/05/06 | 真实分析 + 预览通知 |
| B06 | 邮件渠道、尝试记录、状态核对和回执 | B05 | FR-06/09 | 受控真实发信联调 |
| B07 | 日报、覆盖校验、补报、迟到数据补充 | B06 | FR-07/08 | 完整业务流程可联调 |
| B08 | CLI 运维、事故通知、预算、备份与清理 | B07 | FR-11/12、NFR-05/06/08 | 可运维的候选版本 |
| B09 | 发布包装、故障演练、preview 试运行与 live 门槛 | B08 | 全部 P0、AC-01–20 | V1 生产发布 |
| B10 | 多来源/新渠道/管理 UI/官方交叉核实 | B09 | P1/P2 | 独立后续版本 |

B04–B06 的外部账号权限、预算和发件身份可以在早期提前准备；主体代码仍按依赖顺序验收。B02 的迁移与备份基础不能拖到 B08，B08 只是补操作入口和自动化策略。

```mermaid
flowchart LR
  B00[已完成框架] --> B01[领域合同]
  B01 --> B02[SQLite 与事务]
  B02 --> B03[可恢复流程]
  B03 --> B04[真实 X]
  B04 --> B05[分析与重置]
  B05 --> B06[邮件与核对]
  B06 --> B07[日报与补报]
  B07 --> B08[运维与预算]
  B08 --> B09[部署与验收]
  B09 --> B10[扩展功能]
```

## 2. 保留与演进现有代码

| 当前入口 | 后续处理 | 原因 |
| --- | --- | --- |
| `src/domain/model.ts` / `ports.ts` | 拆成按业务分组的文件，保留稳定导出入口一段时间 | 模型增长后仍能快速定位，减少一次性破坏全部导入 |
| `application/poll-target.ts` | 演进为完整抓取 + 原子写入帖子/分析待办；分析移到独立用例 | 不能因模型故障反复拉取同一批数据或丢失待分析工作 |
| `WatchStore.commitPoll` | 迁移为 `commitIngestion` 与 `commitAnalysis` 两个明确事务合同 | 用持久化分析作业连接两个阶段，保留一致性而非跨网络事务 |
| `application/deliver-notifications.ts` | 保留应用用例，加入执行权、attempt 和核对逻辑 | 不能仅凭一次 HTTP 调用判断送达 |
| `application/daily-digest.ts` | 改用报告记录/覆盖区间/版本化快照 | 一次 lastPoll 检查不足以证明完整昨日数据 |
| `runtime/scheduler.ts` | 保留可注入时钟；将 Map 中进度改为存储状态，独立安排各类工作 | 重启/慢任务不能打乱提醒和日报 |
| `bootstrap.ts` | 分出 demo、preview、live 组合；当前 live 拒绝保护保留到 B09 | 防止半完成的真实能力被误启动 |
| `MemoryStore` / fixture / PreviewChannel | 长期保留，并与生产实现共用契约测试 | 快速测试和展示不依赖付费外部账号 |
| `tests/framework.test.ts` | 保留原有回归测试，按合同/应用/运行时/适配器逐步拆分 | 避免单一测试文件成为维护瓶颈 |

不引入消息队列中间件、微服务或动态执行插件；在单进程 + SQLite 中实现持久化作业即可。未来有真实规模需求再替换端口实现。

## 3. B01 — 领域合同、配置与状态机

**目标：让后续各模块共享同一套业务语义。**

建议拆成 3 个小提交：

1. B01.1 定义帖子版本、来源覆盖、分析作业、规则事件、报告、通知、发送尝试、运行执行权；区分事件状态、报告状态与投递状态。
2. B01.2 定义初始回溯、过期提醒、日报时间、补报上限、重试与保留策略；实现配置 schema/跨字段校验和安全默认值。
3. B01.3 定义 `commitIngestion` / `commitAnalysis` / `createReportWithNotification` / `claimDelivery` 等合同，调整内存实现和模拟用例。

主要位置（均为拟新增或调整）：

```text
src/domain/models/{target,post,coverage,analysis,report,notification,runtime}.ts
src/domain/ports/{source,analysis,store,notification,clock,events}.ts
src/domain/policies/{bootstrap,retry,reset,digest}.ts
src/config/{schema,load,validate}.ts
src/adapters/storage/memory-store.ts
docs/decisions/0001-ingestion-analysis-transactions.md
```

合同必须明确：

- 分页终止/完整性、查询覆盖与历史 gap 的表达。
- 作业唯一键、规则版本和升级重分析不自动重发历史邮件。
- `needs_attention` 与 `provider_accepted`/`delivered` 的区别。
- `Clock` 的业务时刻与单调等待时间能力；所有阈值可测试。
- 收件配置快照不可变，隐私字段不进入通用事件。

验收：AC-01/06/17 的模拟测试、所有非法配置/状态转换失败，旧 demo 继续运行。完成条件：新端口有内存参考实现与契约测试，需求/模型无悬空状态，不接真实网络。

## 4. B02 — SQLite、事务和执行权

**目标：重启后仍知道抓到了什么、需要分析什么、哪些通知可能已发送。**

建议拆成 4 个小提交：

1. B02.1 连接与 schema version、建表、索引、唯一约束、无损 migration runner；未知未来 schema 拒绝写入。
2. B02.2 抓取/分析/报告/outbox 原子操作、revision 比较、读取快照与查重。
3. B02.3 宿主执行权、作业领取、通知 attempt、过期/失联宿主处理与人工待核对。
4. B02.4 一致性备份/恢复基础、损坏数据库拒启及迁移恢复测试。

主要位置：

```text
src/adapters/storage/sqlite/{connection,migrations,store,claims,backup}.ts
src/adapters/storage/sqlite/migrations/*
tests/contracts/watch-store.contract.ts
tests/storage/{migrations,transactions,recovery,concurrency}.test.ts
```

建议逻辑表：targets、checkpoints、coverage_ranges、post_versions、analysis_jobs、analysis_results、rule_events、digest_reports、notifications、delivery_attempts、runtime_ownership、audit_events、schema_migrations。

数据库不存明文密钥；收件地址作为受保护的通知快照只留在本地数据目录。表可以按访问模式合并，但必须保持对应约束。

验收：AC-03/04/05/11/13/16/20 的存储合同；事务中途失败无部分写入、两个连接竞争只允许一个领取者、坏库不被空库替换、恢复保留去重信息。所有数据库事务回调只能做同步操作。

补充容量验证：按 NFR-09 使用 10 个模拟目标和 10 万条历史版本，记录索引、查询计划、分页耗时及机器规格，避免全表加载。

完成条件：同一套合同测试同时通过 MemoryStore 和 SQLiteStore；模拟流程换成 SQLite 后重启不重发已处理事件。尚不发送真实邮件。

## 5. B03 — 可恢复业务流程与常驻宿主

**目标：先用模拟服务证明无人值守流程可靠。**

建议拆成 3 个小提交：

1. B03.1 `IngestTarget`、`ProcessAnalysisJob`、`ProcessDelivery` 用例分离；每个阶段都有持久化任务与失败状态。
2. B03.2 `host` 周期唤醒调度器，持久化 nextPollAt/nextRetryAt；独立调度抓取、分析、通知、到期报告触发器。
3. B03.3 启动恢复、优雅停止、单宿主互斥、重启追赶与系统时间跳变。

主要位置：

```text
src/application/{ingest-target,process-analysis,deliver-notifications,recover-runtime}.ts
src/runtime/{host,scheduler,retry-policy,shutdown}.ts
src/adapters/clock.ts
src/bootstrap/{demo,preview,live}.ts
tests/runtime/{scheduling,shutdown,restart}.test.ts
```

内存进度不能作为生产真相来源。网络调用在数据库事务外；慢 X 请求不能堵住已经排队的提醒。失败隔离应到目标/作业，不依赖一个覆盖全部循环的大 try/catch。

验收：AC-04/05/07/09/11/14/15；模拟一整天、停机数日、午夜/08:00、系统时间跳变，以及任意关键点崩溃。通知处理中断后留 needs_attention。

完成条件：在模拟外部服务 + SQLite 条件下，能连续启动/停止/重启并得到一致结果；宿主已有正常与故障退出码。真实适配器仍未开放。

## 6. B04 — 真实 X 只读接入

**目标：验证来源协议和账号访问，不让邮件影响读取调试。**

建议拆成 3 个小提交：

1. B04.1 核对官方文档和实际账号权限，将核验日期、字段、分页/历史限制写入 `docs/integrations/x.md`；不保存凭据或私有响应。
2. B04.2 用户 ID 解析/固定、完整文本、增量分页、查询覆盖、回复/转推/引用映射与边界校验。
3. B04.3 超时/限流/退避、错误分类、首次回溯、恢复补抓与 preview/probe 命令。

主要位置：

```text
src/adapters/source/x/{client,source,mapper,schemas,errors}.ts
src/application/{resolve-target,probe-source}.ts
tests/adapters/x-source.test.ts
tests/fixtures/x/*
docs/integrations/x.md
```

使用 fake HTTP/server 和合成响应覆盖协议测试；真实 smoke check 必须显式运行且不进默认 test/demo/CI。协议响应先校验 unknown，再转换为领域模型。

验收：AC-02/03/09/14/17；完整分页、重复页、无新帖、部分失败、字段缺失、429、身份不符、长推文、截断内容、历史缺口。游标只在完整抓取事务后前移。

完成条件：真实账号可读取、来源覆盖可解释，preview 只产生本地数据/预览。外部权限不具备时继续完成模拟协议测试并标记 live 验证未通过，不虚报接入成功。

## 7. B05 — 分析、重置判定与时间证据

**目标：生成可核查的中文结果，避免错误的重置时间。**

建议拆成 3 个小提交：

1. B05.1 分析输出 schema、产品/发布状态分类、原文证据与时间语义模型；保持 fixture 分析器。
2. B05.2 真实分析适配器、版本化提示、结果验证、超时/预算/重试和缓存键。
3. B05.3 ResetRule、首次历史过滤、过期判断、待确认标签、更正版本和评估集。

主要位置：

```text
src/adapters/analysis/{client,analyzer,prompts,schemas}.ts
src/domain/policies/{reset-eligibility,time-resolution}.ts
src/application/rules/reset-rule.ts
src/application/process-analysis.ts
tests/analysis/{schema,evidence,time,classification}.test.ts
evals/reset/{cases,runner,README}.*
```

模型不发送邮件，只输出数据；应用层验证后生成规则事件。数据中有 reset 单词不是充分条件；没有这个单词也不是跳过的充分条件。时间转换只在可证明无歧义时执行。

验收：AC-06/17/19；至少包含中文/英文、否定/提问、引用他人、API vs ChatGPT、计划 vs 已发布、相对时间、时区歧义、提示注入及输出截断。评估阈值使用需求文档第 7 节，不自报主观“准确”。

完成条件：分析结果可追溯到具体帖子版本；模型故障不阻断抓取；新规则事件通过 preview 展示；尚不启用定时真实发信。

## 8. B06 — 真实邮件、发送尝试与核对

**目标：可控地发出提醒，并正确处理“不知道是否发出去”。**

建议拆成 3 个小提交：

1. B06.1 供应商适配器、纯文本模板、发件身份校验、配置收件人、稳定通知 ID；协议事实记录到 `docs/integrations/mail.md`。
2. B06.2 attempt 与幂等期限、明确拒绝/不明结果分类、自动重试上限、状态查询/回执处理（如支持）。
3. B06.3 `reconcile` 只读核对与 `resolve` 显式处理，revision 校验和审计；未知结果不自动重发。

主要位置：

```text
src/adapters/notification/email/{client,channel,receipt,schemas}.ts
src/application/{deliver-notifications,reconcile-notification,resolve-notification}.ts
src/application/templates/reset-email.ts
tests/notification/{delivery,idempotency,reconciliation}.test.ts
```

供应商无回执时，状态保持 provider_accepted/unknown，不伪装 delivered。恢复不得用最新邮件猜对应记录。改变收件配置不改变已有通知快照。

验收：AC-11/12/13/20；提交前崩溃、提交后响应丢失、供应商明确拒绝、重复回执、幂等过期、两个发送者竞争。真实测试只能发送到配置的测试收件人，CI 使用模拟服务。

完成条件：单条明确授权的联调消息可以核对供应商结果；任何不明结果都保留待核对记录。全自动 live 开关仍留到 B09。

## 9. B07 — 每日摘要、补发与历史补充

**目标：08:00 的报告日期正确、来源完整、重启不重复。**

建议拆成 3 个小提交：

1. B07.1 日报日期键、覆盖区间验证、08:00 必要补查与 08:15 降级/延迟策略。
2. B07.2 中文摘要模板、来源列表、产品/确定性区分、空日报状态、报告与通知原子创建。
3. B07.3 漏日报追赶、7 日上限、历史邮件节流、迟到/编辑/删除补充与报告 revision。

主要位置：

```text
src/domain/policies/{digest-window,digest-readiness,catch-up}.ts
src/application/{plan-digests,build-digest,create-addendum}.ts
src/application/templates/digest-email.ts
src/adapters/storage/sqlite/report-store.ts
tests/digest/{windows,coverage,catch-up,correction}.test.ts
```

来源不完整就不能声称日报完整；分析未完成的摘录必须明确标注。无昨日报告内容但有历史补充时允许发补充邮件。历史重置消息与真正新消息分开处理。

验收：AC-07/08/09/10；正常 08:00、日期/时区边界、停机 1/7/10 天、来源故障与模型故障分别处理、重复触发、补充版本去重、已有通知正文不可改写。

完成条件：从真实来源到摘要预览/受控邮件联调的全流程通过；不需要为了文案再引入额外一次 LLM 调用。

## 10. B08 — 运维、事故、预算与保留

**目标：用户能知道 agent 是否在工作，并能在故障后恢复。**

建议拆成 3 个小提交：

1. B08.1 CLI status/check-now/preview/notification resolve，非敏感结构化日志、指标及服务异常/恢复事件。
2. B08.2 分析/来源/邮件用量统计、可配置限额、预算暂停与低噪声事故通知。
3. B08.3 备份/恢复命令、数据保留与清理、历史导出和运维手册。

主要位置：

```text
src/cli/{commands,output}.ts
src/application/{health,incident-notifications,budget,retention,backup}.ts
src/adapters/observability/{logger,metrics}.ts
tests/operations/{health,privacy,budget,retention,backup}.test.ts
docs/OPERATIONS.md
```

数据库备份能力已经在 B02 实现；本块添加用户入口、计划和操作说明。监控信息必须区分“无新帖”“抓取失败”“预算耗尽”。通知渠道失效时本地状态仍可用。

验收：AC-13/14/16/18/20；连续故障只通知一次、恢复一次、日志无密钥/邮箱/正文、触顶暂停、清理不删未决数据、备份恢复后去重正常。

完成条件：无需直接改数据库就能完成日常查看、核对与恢复；运行手册列出清楚的动作及其影响。

## 11. B09 — 发布包装与生产门槛

**目标：交付能持续运行的 V1，而不只是能手动执行一次的脚本。**

建议拆成 3 个小提交/发布步骤：

1. B09.1 选定首发主机平台，提供服务启动/停止/健康检查、数据目录与日志位置、持久卷/备份说明；按实际平台实现 Docker/systemd/Windows 服务包装中的一种。
2. B09.2 完成 AC-01–20、全套故障注入、从旧版本升级与回滚保护、Linux/Windows 核心 CI；记录 NFR-03 的提醒/日报时效和 NFR-09 的容量测量，区分目标值与实际结果。
3. B09.3 至少 48 小时 preview，检查数据覆盖、摘要、重置判定和调用成本；完成受控邮件测试后配置 live。记录版本、环境和验证结果，保留回退路径。

主要位置：`deploy/`、`scripts/`、`docs/OPERATIONS.md`、`docs/RELEASE_CHECKLIST.md`、集成与端到端测试目录。

上线门槛：

- 当前持久化 schema 已备份；旧库升级和损坏恢复验证通过。
- X/模型/邮箱权限与凭据可用，不存在未解释的覆盖缺口。
- 所有 P0 与验收通过；明确重置识别达到文档阈值。
- 必需监测/事故/人工核对入口可用；不会把未知发送自动改成 pending。
- 运行期间主机保持在线；休眠/断网的补抓和补报策略有明确说明。
- 版本记录分开列出自动化测试、实际外部联调和仍未验证的限制。

完成条件：用户可以用文档中的命令部署、查看状态、停止和恢复；到此才宣布“真实 agent 已启用”。

## 12. B10 — 可选扩展的顺序

1. 多目标配置与更多纯业务规则，验证隔离和单目标故障不会拖累其他目标。
2. 新来源/通知渠道，通过现有端口实现；目的地模型使用 tagged union 并为旧通知提供迁移。
3. 官方发布来源交叉核实，摘要区分作者观点、官方确认和推断，不能混成单一可信度。
4. 本地管理界面：只绑定回环、写请求校验会话与 CSRF，后台服务独立于页面；界面调用应用用例，不直接写数据库。
5. 只有测量证明单机不满足需求时，才考虑额外队列/远端数据库/多宿主架构。

每项独立发版，不把它们夹进前面的 P0 发布中。

## 13. 代码组织目标

下列目录是**目标结构**，不是当前仓库已经存在的全部文件。

```text
src/
  domain/
    models/          帖子/作业/报告/投递状态
    ports/           外部服务与存储合同
    policies/        时间、资格、退避、预算规则
  application/
    ingestion/       查询与原子写入
    analysis/        分析作业与证据校验
    rules/           重置等可插拔规则
    reporting/       日报/补报/历史补充
    notification/    通知生成/发送/核对
    operations/      健康、备份、保留、预算
  adapters/
    source/x/
    analysis/
    notification/email/
    storage/sqlite/
    observability/
  runtime/           宿主、调度、停止与恢复
  config/            配置 schema/加载/校验
  bootstrap/         demo/preview/live 依赖组装
  cli/               用户命令与脱敏输出
tests/
  contracts/         内存与生产适配器共享合同
  application/       业务规则/时钟边界
  adapters/          协议解析与故障映射
  storage/           迁移/事务/并发/恢复
  runtime/           调度/停止/重启
  integration/       默认模拟，真实联调另设显式入口
evals/               语义质量样例与评估
```

目录拆分随对应块发生，避免一次性创建大量空文件。新服务接入主要改变 adapters 和 bootstrap；新增规则主要改变 domain/application；调度不导入任何供应商 SDK。

## 14. 每块共同的完成定义

- 对应需求编号、状态/异常决策、代码入口和测试都能互相追踪。
- `npm run check`、`npm test`、`npm run demo` 通过；不得让默认测试依赖真实服务。
- 涉及持久化必须有迁移与兼容性测试；涉及发送必须有未知结果与重启测试。
- README 的能力状态、ROADMAP 的完成项、必要的架构/操作说明同步更新。
- PR 范围只包含一个可审查的子块；不混入下一阶段的功能。
- 真实密钥、实际收件地址、真实推文记录、数据库、个人绝对路径不进入提交。
- 拒绝用“demo 通过”替代真实联调；未验证的权限、成本、送达能力明确标注。

## 15. 下一次编码任务建议（B01 完成后）

从 **B02.1：SQLite 连接与 schema 迁移** 开始，先实现建表、索引、版本检查、无损迁移及失败测试。保持真实 X/模型/邮件关闭。

可直接使用的任务描述：

> 按本计划 B02.1 实现 SQLite 连接、schema、索引和无损迁移。复用 B01 的领域合同，不开放 live；补迁移失败、未知版本、坏库拒启测试，更新路线图后运行 check/test/demo。

任务应以完成门槛划分，不预先承诺未经估算的工期。每个块完成后用实际发现校准后续拆分，避免把 API 权限等待算成代码开发已完成。
