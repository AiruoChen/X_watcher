# 调度与运行（B03 / v0.4）

已实现常驻宿主与 SQLite 调度。本文主体记录 B03 模拟运行；v0.5/B04 新增显式 x:probe/x:preview 官方 X 只读入口，真实账号仍待用户配置 Token 后核验，见 [X 接入说明](integrations/x.md)。watch 继续使用模拟来源，preview 不运行模型、日报或邮件。

## 入口

```sh
npm run runtime:demo
# 在忽略的 .env 中设置 APP_MODE=demo、STORAGE_KIND=sqlite：
npm run watch -- --create
# 已有库：
npm run watch
```

`watch` 在前台使用系统时钟运行，空 FixtureSource 不产生推文，PreviewChannel 不发邮件。Ctrl+C / SIGTERM 请求停止。首次创建必须传 `--create`，已有损坏/未知版本库一律拒绝；现有旧 schema 经验证备份后升级。没有另行安装系统服务或启动后台进程。`npm start` 保留一次性固定时钟演示。

`runtime:demo` 使用临时 SQLite、虚构帖子和虚拟时钟，连续两次启动/停止/重开，验证只产生一份摘要预览并清理临时目录。

## 模块与接口

| 入口 | 职责 |
| --- | --- |
| `domain/models/runtime.ts` / `ports/runtime.ts` | ScheduledTask、RuntimeState、RuntimeJobs、ExecutionContext、Waiter |
| `application/ingest-target.ts` | 完整查询后提交版本、覆盖、检查点与分析待办 |
| `application/process-analysis.ts` | 有界领取分析待办，保存结果/通知或独立重试时间 |
| `application/deliver-notifications.ts` | 有界领取通知，保存供应商结果；不明请求隔离 |
| `application/due-digests.ts` | 按时区选取尚无报告的到期自然日 |
| `application/recover-runtime.ts` | 新宿主先隔离遗留业务领取，再恢复阶段触发器 |
| `runtime/workflow-scheduler.ts` | 只依赖领域端口，决定阶段何时执行 |
| `runtime/host.ts` | 执行权、单调计时唤醒/续租、停止与退出码 |
| `adapters/execution.ts` | 定时等待、每次调用的超时/取消、隔离迟到响应 |
| `adapters/storage/sqlite/runtime-state.ts` | 同步事务、revision 领取与状态持久化 |
| `bootstrap-runtime.ts` | 注入实现，校验模式、模拟能力与持久化要求 |

旧 `createApplication` / `Scheduler.tick()` 保留用于内存演示和兼容调用。它们没有常驻宿主保证。新的 `createRuntimeApplication` 返回 `{host, scheduler}`，常驻使用 `host.run()`，停止使用 `host.stop()`，不绕过执行权直接操作调度器。

## 调度与持久化

Schema 3 新增 `runtime_tasks`，以稳定 ID 标识每目标 ingest、analysis、digest 以及全局 delivery。行内保存 stage、目标、配置指纹、revision、idle/running/needs_attention、dueAt、失败次数及起止时刻。ingest 的 dueAt 是 nextPollAt；失败后的 dueAt 是 nextRetryAt。保留既有业务数据，迁移失败整体回滚。

领取与完成都在独立同步事务中重验宿主执行权和 revision；网络调用不在事务内。同目标同阶段不能同时运行。抓取成功只提交分析待办，分析和投递通过数据库发现新工作；默认阶段唤醒 1 秒，不依赖可能丢失的内存消息。

四个阶段分别最多运行 `floor(RUNTIME_MAX_CONCURRENT / 4)` 个任务，默认每阶段 2 个，总量不超过 8。投递当前只有一个全局触发器。目标间轮转，慢来源和慢分析不会占用投递或日报的执行位置。分析/投递每次最多处理 RUNTIME_BATCH_SIZE 条，默认 50。

抓取按配置的 30 分钟间隔运行，失败指数退避和注入抖动。达到 RETRY_MAX_ATTEMPTS 后，该目标的 ingest 触发器保留 needs_attention，不因重启清零；其他目标和阶段继续。分析失败由每个 AnalysisJob 的 nextAttemptAt 与 attempts 管理，耗尽后单作业 needs_attention，阶段继续接收新作业。投递优先查询 reset/correction，再查询普通通知，同优先级保持 FIFO；每次调用后重新取一条，刚到达的重置提醒可以插到尚未领取的日报前，不能打断已提交的邮件。SQLite 使用优先级表达式索引，在应用 limit 之前排序。邮件明确拒绝保存 failed，异常/超时/取消保存 needs_attention；B06 再实现供应商核对和安全重试，当前没有人工重新入队命令。

运行等待、轮询间隔、续租和调用超时使用单调时间；日历窗口使用带时区的墙上时间。dueAt 跨重启保留，进程内转换为单调截止点；一般未来等待最多为 `max(该阶段正常间隔, RETRY_MAX_SECONDS)`，防止校时回退造成数日停摆。B04 的供应商 retryNotBeforeAt 是额外硬下限，不因该上限而提前调用。墙上时间未追上既有检查点时，不向后提交检查点，不虚构查询覆盖。

日报在当地 08:00 后覆盖前一天完整自然日，启动时追赶最近 DIGEST_CATCH_UP_DAYS 个已到期日期，08:00 前也可处理更早的逾期日期。首次回溯起点之前不生成报告。已有报告按唯一键跳过，每轮跨目标最多创建 MAX_CATCH_UP_EMAILS 封非空摘要；空报告不发邮件。缺覆盖或缺分析的日期继续等待，不能标为空，也不会阻塞其他完整日期。08:15 降级、超出追赶期的显式处置、迟到/修改后的报告修订由 B07 实现。

## 执行权与恢复

启动先 acquire。已有有效宿主时返回 already_running，不进行恢复或领取。仅当旧记录同主机、期限已过且 OS 确认 PID 已死，才允许替换；跨主机、未知存活与 PID 复用保持拒绝。宿主每租约时长的三分之一续租；连接的写入有效期同时由单调时间约束，墙上时钟跳变不会误判本进程过期。owner 和 revision 始终重验，失去执行权后不能继续写入。

取得执行权之后，先用 B02 的 recoverAbandonedWork 隔离其他 worker 遗留的 processing 分析和 sending 邮件，再把遗留 running 阶段触发器恢复为 idle、dueAt=启动时间。两步都幂等，有审计，任一步中断可再次启动恢复。分析采用保守策略，同样保持 needs_attention；当前不自动重新入队。恢复阶段触发器只允许服务其他 pending 工作，不改变未决通知。

打开 SQLite 或 close 本身不做恢复、不释放执行权。成功停止时仅在所有 processing/sending/running 都已落盘后 release；落盘失败保留执行权及原始未决状态，不宣称停止成功。异常进程遗留的租约可能需要等待期限和存活确认，不能直接删行解锁。

## 停止与超时

收到停止请求立即停止领取新阶段；已运行的分析/投递允许结束当前调用，循环在下一次领取前检查 ExecutionContext.canClaim。到达 RUNTIME_SHUTDOWN_SECONDS 才通过 AbortSignal 取消在途调用，抓取不提交不完整结果，分析保存 retry_wait 或 needs_attention，邮件保存 unknown/needs_attention，然后等待数据库写入完成。

每次来源/模型/邮件调用分别使用配置的超时。ExecutionContext.call 为适配器传入 AbortSignal；适配器即使忽略取消，迟到的 Promise 也不能再次提交结果或覆盖 unknown。后续真实适配器必须遵守信号并释放网络资源；这里不承诺强行终止任意第三方进程。

| 退出码 | 含义 |
| --- | --- |
| 0 | 正常停止，在途结果已保存、执行权已释放 |
| 1 | 配置/启动/执行权/持久化失败，或已有宿主；检查本地状态 |
| 2 | 超过停止宽限，在途调用已取消并保存保守结果 |

宿主不会自动打印错误响应、邮件正文、完整收件地址、凭据和数据库绝对路径。更完整的 status、故障事故通知、人工核对/恢复入口、预算与系统服务包装仍在 B06/B08/B09。

## 验证

`tests/runtime.test.ts` 使用真实 SQLite、注入时钟和合成数据，覆盖持久化退避、CAS、慢来源隔离、整天/跨日/08:00、离线数日、墙钟前后跳变、续租互斥、强杀进程恢复、正常停止、停止超时、迟到响应与落盘失败。所有外部服务为模拟。执行 check、test、demo、storage:demo、runtime:demo；CI 覆盖 Linux/Windows × Node 22.12/24。
