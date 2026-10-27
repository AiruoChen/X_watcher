# 运维、预算与保留（B08 / v0.9）

本模块提供真实本地 SQLite 运维能力与可注入预算/事故接口。所有新增验证和演示使用合成数据。真实 RSSHub 实例、模型质量、邮件供应商与生产发布仍待受控验收；source-only preview 只读取来源，live 继续拒绝启动。

## 日常查看

沿用根目录忽略的 .env 中 DATABASE_PATH / STORAGE_KIND=sqlite。下面的 ops:* 命令只操作现有库，不需要真实服务密钥；缺库不会自动重建。升级前先停止旧宿主。旧库会先生成有效备份，再无损迁移到 schema 7；用新版本重新启动后，预算与控制队列才由新宿主消费。

```powershell
npm run ops:status
npm run ops:metrics
npm run ops:usage
npm run ops:notifications -- 50
npm run ops:analysis -- 50
npm run ops:check-now -- thsottiaux
npm run ops:command -- <返回的命令ID>
npm run ops:stop
npm run ops:recover
npm run operations:demo
```

status 展示模式、存储目标、覆盖范围、抓取观察时间、阶段的上次/下次执行、失败/等待状态、待分析/待投递/待核对计数、日报状态、事故与预算。RSSHub 的 gap / unverified 不会变成完整覆盖。“无新帖”依据一次成功查询；失败、陈旧、预算耗尽各有独立信息。metrics 是同一脱敏 JSON 快照，usage 给出持久化日汇总。

check-now 追加命令，由已有宿主更新同一 ingest 任务；同一目标请求合并到一次领取。执行中的任务、供应商下限、退避和预算仍有约束。没有宿主时命令等待下次启动；超过 24 小时的请求拒绝执行。使用 ops:command 查询 applied / rejected 及原因，不能把 queued 当作已经抓取。

stop 指向请求时的宿主会话；旧命令不能停止后来启动的宿主。宿主停止领取并等待在途结果落盘。以 status 中 runtime.active=false 确认结束，关闭浏览器不停止后台进程。

recover 只取得本地执行权并调用原有恢复核对。活跃/活性未知/其他主机的执行权会阻止操作。中断分析隔离为 needs_attention，发送结果不明保持待核对；它不发送邮件，不重新调用远端，也不自动退款调用许可。

## 故障后的明确动作

```powershell
# 从 status 获取准确 task ID 与 revision，修正配置/凭据后申请重试
npm run ops:resume -- <taskId> <revision> "已核对并修正配置"
# 从 ops:analysis 获取准确 job ID 与 revision，显式重试纯分析
npm run ops:retry-analysis -- <jobId> <revision> "已核对该分析作业"
# 邮件仍沿用 B06 精确核对接口；先停止宿主
npm run mail:status -- <notificationId>
npm run mail:resolve -- <notificationId> <attemptId> <revision> confirm_sent operator "已核对精确发送记录"
```

resume 只处理 needs_attention 或预算暂停的任务，并校验 revision。供应商给定的等待下限不能被普通 resume/check-now 清除。预算暂停可显式重验，但实际调用仍需重新取得预算许可，既有用量不清零。retry-analysis 仅消费明确指定且仍为 needs_attention 的作业，保留帖子和分析版本；运行中作业不能改写。

邮件 confirm_not_sent_retry / abandon 的影响与精确匹配条件见 [邮件模块](integrations/mail.md)。未知结果不能因为预算跨日、恢复或重启而自动重发。当前未选邮件服务，不能做真实供应商核对。

历史范围已超过上游能力时，resume 不能补出不可用数据。保留原库和 gap；如决定从新起点重新监测，可备份旧库并显式配置一个新的 DATABASE_PATH 后使用来源 preview --create。旧数据留作历史核查，新的有限数据不能声称覆盖了缺失区间。本版不提供直接跳过权威检查点或伪造完整覆盖的命令。

## 事故、日志与指标

- 连续故障达到 FAILURE_THRESHOLD（默认 3）开启事故；明确不可重试的来源错误立即开启。一次事故只创建一个异常通知，成功实际查询后创建一个恢复通知。后续新事故递增 generation，跨重启保持去重。
- 超过 STALE_AFTER_MINUTES（默认 90）没有成功抓取时显示 stale；没有新帖不表示陈旧，只要完整查询仍在成功。
- 邮件未知/拒绝在本地显示；邮件渠道失效时事故邮件可能同样待发送。本地 status 和日志是独立出口，不能声称提醒已经到达。
- preview 只保存本地健康与预算事故，不创建邮件。demo 的事故通知由模拟渠道处理。
- ConsoleEvents 显式选择事件类型、阶段、计数和标识摘要，额外 token、邮箱、正文、异常对象不会进入日志。status / notifications 不打印收件地址、正文、凭据或数据库路径。明确请求的报告预览/历史导出可以包含内容。
- 用量汇总记录来源请求、模型调用、邮件尝试及已知 tokens。measuredCalls / unmeasuredCalls 标识测量覆盖，未知 tokens 不能被视为实际为零。

## 预算配置

默认各上限为空：持续记账，但没有人为设定调用配额。调用的预算日期按 TIME_ZONE 的自然日计算；已记录日期只向前推进，时钟后退不能重新领取旧额度。

```dotenv
MAX_CALLS_PER_DAY=
MAX_SOURCE_CALLS_PER_DAY=
MAX_ANALYSIS_CALLS_PER_DAY=
MAX_MAIL_CALLS_PER_DAY=
MAX_COST_PER_DAY=
SOURCE_MAX_COST_PER_CALL=
ANALYSIS_MAX_COST_PER_CALL=
MAIL_MAX_COST_PER_CALL=
BUDGET_CURRENCY=
BUDGET_PRICE_REFERENCE=
```

全局次数与各服务次数同时生效。来源在每次真正的 HTTP 请求前取得许可，包括官方身份解析与每一页；RSSHub 本次解析缓存不额外计一次请求。分析在可处理的作业被领取前取得许可；零新帖、已有同版本分析不会额外调用。邮件在领取前取得许可，预算不足时仍 pending，尚未尝试的通知不会被标成 unknown。

许可、日汇总和上限核验通过同步事务保存；重启或另一连接不能重置账本。在途/崩溃的许可保守计入已占用配额；只有明确未启动的许可可取消，started/unknown 不能自动退款。失败调用也消耗许可。预算恢复仅说明许可重新可用，来源服务是否恢复由其独立健康记录判断。

达到上限后任务保留预算暂停原因与下一预算日，不消耗来源重试次数，不阻塞其他未触顶服务。跨日重新核验；同一事故的通知保持去重。预算限制邮件本身可能使事故邮件继续等待，本地状态始终可查。

同一预算日已使用的币种会被固定；切换为不同币种会显示 currency_changed，不能把两种货币直接相加。每份许可保留币种、单价依据与配置 revision，以便追溯。

费用由用户核实并配置“每次调用的估算上界”、三位币种和单价依据；最多 6 位小数，以整数微单位计算。不内置供应商价格。费用上限按这些配置估算执行，不是供应商账单或未经验证的实际消费承诺。没有价格或本日已有无法定价的调用时，费用预算拒绝放行相应调用，显示 price_unknown；不能把未知当成免费。

常驻 preview 使用同一持久账本。独立 probe 默认保持无数据库诊断，输出 diagnostic_only；配置了任意预算时，probe 必须使用已有数据库记账，数据库缺失/被其他宿主占用时会在调用前拒绝。普通诊断探测不是监测用量账本的替代品。

## 备份、恢复与历史导出

建议每日一份备份，升级和清理前额外备份；定期用新路径恢复并核查去重。B09 已提供可选的隔离 Docker 备份进程与停止/恢复包装，默认不启动；见 [DEPLOYMENT.md](DEPLOYMENT.md)。本地人工命令继续可用。

```powershell
npm run ops:backup -- data/backups/manual-01.sqlite
# backup 返回 schemaVersion、sha256、bytes
npm run ops:restore -- data/backups/manual-01.sqlite data/restored-01.sqlite <sha256>
npm run ops:export -- 2026-10-01 2026-10-24 data/exports/history.ndjson
```

备份通过 SQLite 一致性快照并验证 schema / 完整性 / 哈希；恢复只发布到新的文件路径，校验失败保留原库。备份可以包含未决状态；启用恢复副本前先停止原运行实例，并通过本地恢复核对，保留唯一活动数据副本。恢复不会把 needs_attention 改成可重发。

历史导出按配置目标和时区的包含首尾自然日期范围生成 NDJSON，包含所选帖子、分析、报告和通知。文件通过暂存、fsync 和不覆盖发布创建，stdout 只给行数/字节/哈希；现有文件保持原样。导出与备份包含个人内容，保存到忽略的 data/exports、data/backups 等目录；项目也忽略 exports/、backups/ 和 *.ndjson。备份文件的保留/删除由用户管理，本模块不自动删除备份。

## 清理与保留

默认正文/分析 90 天、报告/通知审计 180 天，均受配置校验。真实来源条款尚未核对，所以默认禁止执行清理；AUTO_CLEANUP=true 会明确拒绝，目前只支持停止宿主后的手动维护。

```powershell
# 只返回候选数量、依赖保护数、UTC 预览时刻和 token
npm run ops:cleanup
# 核对实际来源条款后，在忽略的 .env 中设置 RETENTION_TERMS_REVIEWED=true
npm run ops:cleanup -- --apply <preview-at> <preview-token> data/backups/before-cleanup-01.sqlite
```

apply 使用当前保留配置重算相同预览时刻，核验指纹，先创建有效备份，再在事务内重验并清理。后台执行权、在途分析/发送/调度都会阻止清理；候选发生变化需重新预览。不会自动释放任务执行权或丢弃未决工作。

保留规则是最低保留期限，依赖会延长保存：pending / retry_wait / processing / sending / needs_attention、未完成报告、已保存报告的帖子与分析、父报告链和更正引用都受保护。刚完成分析、刚投递/人工核对的旧邮件按最近活动继续保留。旧兼容 legacy_posts 采取保守保留。

清理后保留最小帖子/通知/报告去重标识、检查点、日用量汇总和事故代次，防止重启/恢复后再发。已清理正文的日期不能被当作“零帖”；需要原内容时从备份恢复新副本。不可变报告正文可能把依赖保存到超过 90 天。清理只处理记录，SQLite 文件大小不保证立刻缩小。

## 接口与验收边界

OperationsStore / CallGate / CallPermit 为领域接口；BudgetController 和 ManageHealth 编排业务；SqliteOperations、SqliteRetention、ConsoleEvents 与导出适配器处理外部协议。运行层仅消费领域端口，不导入业务用例或数据库 SDK。Schema 7 保留原有 1–6 校验和，升级前有效备份。

operations:demo 完整离线展示预算暂停/跨日恢复、事故去重、备份恢复和保护性清理。新增测试覆盖真实 SQLite 事务、控制命令、跨连接/重启、失败回滚、保留依赖和脱敏 CLI。真实模型/邮件质量与时效、RSSHub 实例、部署包装仍未验收，见 B09 路线图。

## v0.10 部署衔接

部署入口与只读健康检查、同一构建/配置的连续预览证据、发布门禁和可选每日备份见 [DEPLOYMENT.md](DEPLOYMENT.md)。容器内通过 maintenance 服务调用现有 ops:*，不会另建抓取通道。应用/镜像/验收结果与真实服务验证分开记录，见 [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)。
