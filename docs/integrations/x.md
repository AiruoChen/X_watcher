# X 官方 API 只读接入（B04 / v0.5）

用户当前选择自托管 RSSHub，部署与新命令见 [RSSHub 接入](rsshub.md)。本文保留官方 API 可选方案，RSSHub 失败不会自动切换到它。

核对日期：2026-10-23；本机 Node.js v22.12.0。已完成适配器、身份绑定、抓取/存储组装和合成协议测试。**尚未使用用户 Bearer Token 联调**，真实账号权限、余额、字段版本及实际内容返回均待验证。没有启动真实监测后台、模型或邮件。

## 官方依据与选型

| 官方资料 | 本模块采用的合同 |
| --- | --- |
| [用户查询](https://docs.x.com/x-api/users/get-user-by-username) | GET /2/users/by/username/:username；Bearer 认证；请求稳定 ID、用户名与可见性 |
| [Recent Search](https://docs.x.com/x-api/posts/search-recent-posts) | GET /2/tweets/search/recent；七天范围、固定时间边界、next_token 分页、每页 10–100 条 |
| [查询操作符](https://docs.x.com/x-api/posts/search/integrate/operators) | from 查询目标，-is:retweet 排除纯转推；回复和引用中的作者评论保留 |
| [用户时间线](https://docs.x.com/x-api/posts/timelines/introduction) | 时间线最多开放最近 3,200 条；本模块不把该端点分页结束当作任意历史范围完整证明 |
| [限流](https://docs.x.com/x-api/fundamentals/rate-limits) | 读取 x-rate-limit-reset/remaining，不写死账户额度或固定重置周期 |
| [计费](https://docs.x.com/x-api/getting-started/pricing) | 官方按用量计费，实际价格、权限与余额由控制台核对，代码不内置单价 |
| [错误说明](https://developer.x.com/en/support/twitter-api/error-troubleshooting) | 区分 HTTP 权限、限流、供应商故障与 200 部分错误；公开搜索不是所有内容的全集 |

只支持官方 https://api.x.com，GET-only，不使用网页抓取、浏览器 Cookie 或第三方代理 API。默认选 Recent Search，以明确的时间范围表达覆盖；不自动降级到全档搜索、付费升级或时间线端点。

当前官方参考展示 post.fields、note_post、referenced_posts、edit_history_post_ids；旧接口资料仍使用 tweet.fields 等名称。默认 X_FIELD_DIALECT=post，显式 tweet 可用于仍采用旧字段的部署。不会因 400 自动发第二套请求。两种合成协议均测试通过，**实际账户支持哪套字段必须通过探测核验**；不把模拟响应当作真实服务器证据。

## 本地配置与命令

在忽略的 `.env` 中设置以下字段，其余字段可保留模板默认值：

```dotenv
APP_MODE=preview
STORAGE_KIND=sqlite
DATABASE_PATH=data/x-preview.sqlite
WATCH_HANDLES=thsottiaux
SOURCE_PROVIDER=x-api-v2
SOURCE_CREDENTIAL_ENV=X_BEARER_TOKEN
ANALYSIS_PROVIDER=deferred
ANALYSIS_CREDENTIAL_ENV=
ANALYSIS_MODEL=
```

把真实 Token 配置到本地 `X_BEARER_TOKEN` 环境变量或忽略的 `.env`，不要发到聊天、写进命令参数或提交 Git。配置对象仅持有变量名称；诊断输出不包含 Token、完整邮箱、推文正文或数据库绝对路径。使用独立 preview 数据库，不能把模拟作者身份改写为真实作者。

```sh
npm ci
npm run config:check
npm run x:probe
# 探测通过后，首次创建新的 preview 数据库并执行一次到期抓取：
npm run x:preview -- --create --once
# 持续前台轮询；Ctrl+C / SIGTERM 优雅停止：
npm run x:preview
```

这些 x 命令会访问真实 X，可能产生费用。缺配置/凭据时在网络调用及建库前拒绝。demo、watch、默认测试和 CI 均不会因为环境中存在密钥而访问真实服务。APP_MODE=live 继续拒绝启动。

`x:probe` 不打开/创建数据库，不推进检查点、不创建分析/通知：每目标查询身份，再探测最近一小时；最多 1 个搜索页、每页 10 条。更多分页时返回 page_limit/退出 1，表示探测没有取得完整窗口，不表示权限必然不可用。探测不绑定身份；preview 首次成功解析后才将 ID 持久化。

`x:preview` 复用 B03 常驻宿主与执行权，默认每半小时查询。`--once` 等待当前到期抓取结束就停止，不等待下一次重试；已有未来调度时不会强制提前调用。预览只保存原始帖子、范围与待分析作业，**不运行分析、不生成日报、不发送或预览邮件**。分析作业的 emitNotifications=false，后续版本不能无意回放这批历史提醒。B05 再提供真实分析与显式重分析。

退出码：0 为成功/正常停止；1 为配置、权限、未完成抓取或宿主失败；2 为停止宽限超时后已保守保存结果。费用与请求量在 X 控制台核对；CLI 仅统计本进程实际请求数，不提供账单估算。

## 身份、分页与覆盖

每轮先解析用户名。持久化 authorId、展示 handle、首次监测时间和配置指纹；之后每轮必须匹配既有 ID/handle。改名、重新绑定、返回他人作者、受保护或受限账号都停止该目标；不能悄悄覆盖身份。搜索使用已解析 ID 的 from 查询，并逐条验证 author_id。ID 查询语义与账户字段能力包含在实际探测待验范围内。

一次查询固定 `[from,to)`，to 默认落后当前时间 30 秒并按秒对齐；首次 from 仍按实际启动时区中前一天 00:00 计算，午夜附近不因延迟多回溯一天。下一次从已提交检查点继续，额外向前重读 120 秒，以发现部分迟到索引/变更。不会同时设置 since_id 与 start_time，也不依赖“最大 ID”过滤掉迟到内容。

API 的秒级边界通过向外取整覆盖，映射后恢复领域的半开区间。每页使用相同边界和查询，只改变 next_token。所有页成功、计数合法、身份匹配、没有部分错误且无分页循环，才一次提交帖子、分析待办、coverage 和新游标。游标保存版本、固定作者 ID 和已完成边界；临时 next_token 不成为持久检查点。重复单条可去重，重复整页、token 循环、上限与中途异常不推进检查点。

Coverage.scope 明确保存 x_recent_public_index。complete 仅表示**指定公开搜索索引范围**分页已完成，不代表已找回全部真实言论、私密内容或已删帖子。超出七天可见范围（边界预留 60 秒余量）时记录 gap，保留原检查点并将目标调度置 needs_attention；不丢弃较早日期后假装完整。更早历史需要后续显式补档/接受缺口流程，当前没有自动跳过或清空库的恢复办法。余量避免分页过程中滑出可查询范围，并非官方额外保证。

2 分钟重读不能保证捕获所有延迟索引、历史编辑或删除；超出重读范围的修改与日报修订在 B07 处理。未确认删除不会把旧版本标成 deleted。索引为空也仅能说明该范围内没有 API 返回的公开结果。

## 内容映射

- 长正文优先 note_post.text / note_tweet.text；普通正文保持作者自身文字。外链标题、文章卡片和引用原文不会替代或拼接到作者正文。
- original/reply/quote/repost、引用/回复对象的 ID、作者 ID、原文与 URL 分别保存在 origin。缺失上下文、疑似截断或只有文章卡片时标记 truncated，不自动分析/提醒。
- 纯转推通过查询排除，映射器再过滤；引用他人的“重置”不成为作者自己的重置声明。
- 编辑历史首个 ID 作为同一帖的逻辑标识，当前响应 ID、历史 ID 集与内容哈希形成不可变版本。没有编辑历史字段就保留 API 当前 ID，不猜测关系。
- 来源 URL 固定构造为 https://x.com/i/status/:id；不访问正文中的链接，不执行其中指令。

新增 origin/coverage/schedule 字段保存在既有 JSON 快照中；SQLite schema 仍为 3，没有丢弃数据或重建数据库。旧模拟帖子维持原标识算法，原有合同测试不变。

## 超时、限流和故障

每次 HTTP 请求默认最多 10 秒，整个分页调用仍受 SOURCE_TIMEOUT_SECONDS（默认 30 秒）约束。取消和超时终止读取，迟到结果不能落库；响应最多 4MB，JSON/字段先验证 unknown 再转换。关闭重定向，凭据不会转发到其他主机。客户端不做隐藏重试或打印错误正文。

429 按 Retry-After 与 x-rate-limit-reset 的较晚时间等待，用响应 Date 减少本机校时误差；运行中还使用单调时间。本进程共享端点限流门，成功响应 remaining=0 同样约束下一页。调度持久化 retryNotBeforeAt，重启不会被普通最大退避缩短。普通网络/超时/5xx/页数上限继续有限退避。

401/403/404/402、身份变化、格式不兼容与永久历史缺口保守暂停该目标，并保存白名单 failureCode。修正凭据/字段后仍需显式处置已暂停触发器；重启不自动抹掉失败次数。目前没有人工重排 CLI，统一处置属于 B08；不要直接修改身份、删通知或清空数据库“修复”。因此应先运行不持久化的 probe，确认权限与字段再创建 preview。

| 配置 | 默认与作用 |
| --- | --- |
| X_MAX_PAGES / X_PAGE_SIZE | 20 / 100；1–100 页、10–100 条/页，限定单次读取量 |
| X_REQUEST_TIMEOUT_SECONDS | 10；1–300 秒，每次 HTTP 调用 |
| X_SAFETY_LAG_SECONDS | 30；10–3600 秒，为索引留时间 |
| X_OVERLAP_SECONDS | 120；0–3600 秒，重读与本地版本去重 |
| X_FIELD_DIALECT | post；可显式选 tweet，不能设 auto |

单次最多一轮用户解析和 X_MAX_PAGES 个搜索请求；失败后重新抓取可能再次计费。这里没有承诺整个进程的日费用上限。应用级预算/计量由 B08 实现，长期运行前应在 X 控制台设置消费上限；当前字段 MAX_COST_PER_DAY 尚不执行预算。

## 验证与真实联调状态

合成协议测试覆盖：固定身份、两种字段、分页边界/循环/重复/上限、零帖、部分错误、长文/回复/引用/转推、历史缺口、编辑版本/迟到重读、HTTP 401/402/403/404/429/5xx、超时取消、大小限制、重定向、SQLite 重开、宿主隔离及跨重启退避。回环假 HTTP 服务验证原生 fetch 用户查询与多页读取；默认测试/demo/CI 不调用真实 X。

真实联调尚未执行：用户会稍后在本地配置 Token。需核验官方 App Bearer 权限、余额/账单限制、目标稳定 ID、ID from 查询、实际字段版本、分页和返回文本。探测成功只证明该次窗口可查询；至少完成实际 preview 与数据核对后才能记录账号接入已验证。任何报告不得把本章合成测试写成“真实账号已监测成功”。
