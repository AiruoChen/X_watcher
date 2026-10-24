# 自托管 RSSHub 接入与迁移

核对日期：2026-10-23。当前 v0.6 提供代码、离线协议/SQLite/CLI 验证和 Docker Compose 模板；本机未发现 docker 命令，没有启动容器或使用真实 Cookie。模型、日报、重置邮件和 live 仍未实现。此模块完成的是读取层重构。

## 1. 架构和范围

`X 网站 → 自托管 RSSHub（登录 Cookie、Redis 缓存）→ JSON Feed → RsshubSource → IngestTarget → SQLite / 待分析作业`。

RSSHub 用户时间线路由为 `/twitter/user/:id/:routeParams?`。应用请求 `includeReplies=true&includeRts=false&count=100`，使用同一订阅的 `?format=json` 输出。JSON Feed 与 RSS XML 是同一来源的不同序列化；本次没有实现通用 XML/Atom 阅读器。应用不会再调用官方 X API，官方实现保留为显式可选来源，不会在 RSSHub 失败后自动调用付费 API。[RSSHub 用户路由源码](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/twitter/user.ts)、[JSON 输出中间件](https://github.com/DIYgod/RSSHub/blob/master/lib/middleware/template.tsx)。

## 2. 文件与职责

| 修改位置 | 实现内容 |
| --- | --- |
| `src/adapters/source/rsshub/client.ts` | 固定实例和用户路由 GET；JSON 类型/4MB 限制、超时/取消、禁止重定向、HTTP 错误分类与 Retry-After |
| `src/adapters/source/rsshub/mapper.ts` | JSON Feed 校验、X 链接/作者匹配、ID 与发布时间、HTML 转纯文本、引用上下文隔离 |
| `src/adapters/source/rsshub/source.ts` | 实现 PostSource、缓存本轮 resolve 的同一响应、回看窗口、来源专属游标 |
| `src/bootstrap-source.ts` | 按 SOURCE_PROVIDER 组装 rsshub 或 x-api-v2；禁止 demo/live 调用真实来源 |
| `src/source-preview.ts`、`src/cli.ts` | 来源通用探测/持久化入口，增加 rsshub:* / source:*，兼容 x:* |
| `src/config/*`、`src/domain/models/config.ts` | RSSHub 字段、URL/数值校验；RSSHub 不要求应用侧来源凭据 |
| `src/domain/models/{post,coverage}.ts` | 未知正文完整性、未知帖子种类、RSSHub 快照范围和未验证覆盖 |
| `src/application/ingest-target.ts` | 同一事务提交快照、gap、检查点和待办，不把读到响应当成时间段完整 |
| `src/adapters/storage/{memory-store,sqlite/store}.ts` | 允许明确的 RSSHub 未验证观察提交，继续 revision 校验与原子回滚 |
| `deploy/rsshub/` | RSSHub + Redis 模板，宿主端口只绑定 127.0.0.1 |
| `tests/rsshub-source.test.ts` | 合成协议、HTTP、持久化重开、运行隔离、CLI 和退避验证 |

调度器无需导入 RSSHub 或改变 30 分钟调度逻辑。数据库仍为 schema 3，沿用现有 gap 和 JSON 快照，不删除或重建旧表。

## 3. 部署与凭据位置

在项目根目录执行（需要已启动的 Docker Desktop，使用 Linux 容器）：

```powershell
Copy-Item -LiteralPath deploy/rsshub/.env.example -Destination deploy/rsshub/.env
```

只在首次不存在时复制；之后直接编辑 `deploy/rsshub/.env`，设置 `TWITTER_AUTH_TOKEN`。从你自己已登录 X 网站的浏览器开发者工具 → Application/Storage → Cookies → x.com 中读取名为 `auth_token` 的值；只填值，不加 `Bearer` 或 `auth_token=` 前缀。不要把 Cookie 发到聊天、提交 Git 或贴日志。

该变量是网站登录凭据，不是 X 开发者 Bearer Token。RSSHub 当前根据 authToken 选择 Web API；Compose 不配置开发者 API 或第三方计费 API。X 改版、登录过期、限流和账号限制可能让该方式失效，需要维护 RSSHub 和登录状态。[RSSHub 来源选择](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/twitter/api/index.ts)。

```powershell
docker compose --env-file deploy/rsshub/.env -f deploy/rsshub/compose.yaml up -d
docker compose --env-file deploy/rsshub/.env -f deploy/rsshub/compose.yaml ps
```

Redis 不映射宿主端口，缓存卷持久保存。默认路由缓存 300 秒、内容缓存 3600 秒；定时读取可能收到缓存快照，不能用 HTTP 成功推断上游更新成功。[RSSHub 配置源码](https://github.com/DIYgod/RSSHub/blob/master/lib/config.ts)。模板沿用上游镜像；首次验证后在部署 `.env` 中把 RSSHUB_IMAGE/REDIS_IMAGE 固定为验证过的 tag 或 digest。只有该 X 路由，无需另开 browserless 容器。[上游 Compose](https://github.com/DIYgod/RSSHub/blob/master/docker-compose.yml)。

升级前停 watcher 并备份 SQLite，拉取选定镜像，再运行探测；停止服务用同样参数执行 `down`，保留 Redis 卷。不要公开 Docker 的解析后配置或完整容器环境，它们可能含 Cookie。

## 4. 应用配置与运行

根目录 `.env` 中设置：

```dotenv
APP_MODE=preview
WATCH_HANDLES=thsottiaux
POLL_INTERVAL_MINUTES=30
TIME_ZONE=Asia/Shanghai
DAILY_DIGEST_AT=08:00
STORAGE_KIND=sqlite
DATABASE_PATH=data/rsshub-preview.sqlite
SOURCE_PROVIDER=rsshub
SOURCE_CREDENTIAL_ENV=
RSSHUB_BASE_URL=http://127.0.0.1:1200
RSSHUB_ITEM_LIMIT=100
RSSHUB_REQUEST_TIMEOUT_SECONDS=20
RSSHUB_OVERLAP_HOURS=48
RSSHUB_SAFETY_LAG_SECONDS=30
SOURCE_TIMEOUT_SECONDS=30
ANALYSIS_PROVIDER=deferred
ANALYSIS_CREDENTIAL_ENV=
ANALYSIS_MODEL=
```

保留你已有的 NOTIFICATION_TO，但 preview 不发邮件。旧 X_BEARER_TOKEN 可从根目录环境移除或留作官方 API 备用；RSSHub 模式不会读取或发送它。RSSHub Cookie 只放在部署子目录，不能填入 SOURCE_CREDENTIAL_ENV。根目录 .env 和 deploy/rsshub/.env 均已被 Git 忽略。

```powershell
npm run config:check
npm run rsshub:probe
# 首次创建新库；已存在的库去掉 --create
npm run rsshub:preview -- --create --once
# 探测正常后前台常驻，每半小时读取
npm run rsshub:preview
```

`source:probe/source:preview` 按配置选择来源；`rsshub:*` 强制 RSSHub；`x:*` 强制官方 API，配置不匹配拒绝。probe 不打开数据库；preview 只运行抓取并保存待办，不调用分析、日报或通知。

非本机部署须用 HTTPS；BASE_URL 不接受 URL 用户名、密码、query 或 fragment。当前没有 RSSHub ACCESS_KEY/代理登录功能，远端实例需在受控网络提供可访问的 feed 接口；不要把密钥拼进 URL。模板针对 watcher 在宿主机运行，若以后容器化 watcher，需另行设计内部网络和 URL 校验。

## 5. 覆盖、身份和升级合同

- RSSHub 返回有限条目，没有完整时间段证明。完整 HTTP 响应返回 complete=true，但 coverageStatus=unverified；SQLite 原子记录 status=gap、reason=rsshub_snapshot_unverified 以及观察检查点。检查点表示已观察到该时刻，不证明期间无漏帖。空 feed 也不产生完整空日报。
- 默认最多请求 100 条、每次回看 48 小时，结合帖子内容哈希去重。条数只是上游请求参数，不保证获得指定条数；48 小时重读也无法找回已滚出 feed 的帖子。离线、缓存、繁忙期间的缺失不能自动补齐，删除也不能推断。
- RSSHub 不提供本模块可核验的稳定数字用户 ID。目标使用 rsshub-x:<handle> 和 rsshub-handle:<handle>，与官方 x:<handle> 隔离；验证 feed 主页/帖子 URL 的 handle，不能识别同名账号被重新分配。这项能力不满足完整 V1 的稳定账号身份要求，当前只开放 preview。
- HTML 只作数据解析，去掉脚本、媒体、引用框和回复上下文；不访问图片/视频/外链。纯媒体保存明确占位，正文完整性 unknown。引用只保存带归属的链接，不冒充作者正文。上游结构改变时拒绝异常响应。
- 版本由稳定帖子 ID、映射版本及内容哈希区分；能保存重读中出现的编辑，不能恢复完整编辑历史，也不能将新 ID 编辑链自动归并。
- 新应用可以打开原 schema 3；推荐独立 data/rsshub-preview.sqlite，保留旧官方库。切换来源不重写旧身份/游标，也不读取旧来源目标的待办。旧版本不理解新 RSSHub 元数据，回退时停止新进程并使用旧库/备份，不用旧应用运行 RSSHub 数据库。

## 6. 后续分块与验收

1. 真实验证 RSSHub + Cookie，确认目标 feed 可读、登录和缓存行为；连续 preview 运行，记录遗漏限制。
2. B05：分析器需显式支持未知完整性/部分正文，保留来源限制和引用证据；不能把 unknown 改成 full 来绕过当前保护。增加语义评估集。
3. B06：接入邮件并验证发送未知结果处理；维持通知快照和去重。
4. B07（v0.8 业务/离线完成）：`digest:preview <day> --partial` 展示已收集内容并标注可能遗漏；缺口等待、08:15 异常/降级、补报和历史补充合同已实现。完整报告继续要求完整覆盖，所以 RSSHub 不会产出完整日报；source-only preview 不运行报告或邮件。部分来源自动邮件仍须真实服务验收。详见 [日报模块](../REPORTING.md)。
5. B08/B09：登录失效、长期不更新、恢复通知，镜像固定/升级与生产验收。完成后再评估 live。

真实验收检查：probe 应显示 scope=rsshub_timeline_snapshot、coverage=unverified；preview 应新增帖子/待办和 gap；重复读取不重复建作业；停止重开能继续；断网/HTML 错误/429 不推进失败批次检查点，等待时间跨重启保存；始终没有真实模型/邮件操作。

## 7. 排障

| 情况 | 检查 |
| --- | --- |
| docker 命令不可用 | 安装 Docker Desktop、启用 Linux containers，并确认终端 PATH |
| network / timeout | RSSHub 是否已启动、1200 端口是否可达；检查 RSSHub 自己访问 X 的网络 |
| provider（常见 5xx） | 在本机查看 RSSHub 错误，确认 Cookie 未过期和 X 路由仍有效；不要把错误响应全文贴入日志 |
| authentication / permission | 实例访问策略或 RSSHub 登录态；RSSHub 上游认证失败也可能包装为 5xx，应用不能可靠细分 |
| protocol | 返回了 HTML/XML、JSON Feed 字段/作者/日期异常或版本不兼容；先检查镜像版本，不推进检查点 |
| identity_mismatch | 主页/帖子账号不匹配，停止该目标并核对；不会自动换目标 |
| rate_limited | 等待 Retry-After，调度保存期限，避免立即重复请求 |
| needs_attention | 当前没有人工重排命令；保留数据库核对，不能通过重建库掩盖故障 |

读取方式改为 RSSHub 不会消除缓存/账号维护成本，也不能承诺 X 永久可抓。这里未启动任何后台监测、登录或真实邮件。
