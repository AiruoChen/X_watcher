# 部署包装（B09 / v0.10）

本版交付 Docker Linux containers 包装、只读健康检查、可选备份计划及验收工具。运行模式为 demo 或来源只读 preview；真实模型/邮件适配器尚未选定，live 保持禁用。生产发布门槛见 [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)。

首发容器目标为 Linux amd64。Windows 使用 Docker Desktop 的 Linux containers；需要 Docker 守护进程已运行。2026-10-25 本机仅验证了 Compose 解析和 Node/SQLite 流程，实际容器启动/强停恢复由 Linux CI 单独验证，以该 PR 的 CI 结果为准。

## 构建与配置

先停止原本地宿主，保留原 .env 和数据库。容器采用独立 watcher-data 卷；若需延续原检查点，使用下面的停机备份迁移步骤。

1. 从已审阅提交构建，保持工作区干净。根目录执行 npm ci / npm run check / npm test；记录 git rev-parse HEAD。
2. 按 [RSSHub 指南](integrations/rsshub.md) 准备 deploy/rsshub/.env，Cookie 只交给 RSSHub。
3. 仅首次复制 deploy/watcher/watcher.env.example 为同目录 watcher.env，配置目标、时区和预算。此文件已忽略，不进 Git。示例收件人仅为无效地址，preview 不发送邮件。
4. 在已有 RSSHub 配置中选择并记录 RSSHUB_IMAGE、REDIS_IMAGE 的实际版本或 digest；不把 latest 当作已固定的生产版本。默认 watcher 基础镜像是已核对的 node:22.23.4-bookworm-slim，可通过 NODE_IMAGE 固定已验证 digest。实际镜像 ID 和运行 Node 版本由容器验收产物记录。

PowerShell 示例：

```powershell
if (-not (Test-Path -LiteralPath deploy/watcher/watcher.env)) {
  Copy-Item -LiteralPath deploy/watcher/watcher.env.example -Destination deploy/watcher/watcher.env
}
$env:BUILD_REVISION = (git rev-parse HEAD).Trim()
$composeArgs = @('compose', '--project-name', 'x-watcher-rsshub',
  '--env-file', 'deploy/rsshub/.env',
  '-f', 'deploy/rsshub/compose.yaml', '-f', 'deploy/watcher/compose.yaml')
docker @composeArgs config --quiet
docker @composeArgs build watcher
```

Compose 文件必须按上述顺序合并，路径基于第一份文件。使用 config --quiet 校验，避免把含 Cookie 的配置打印出来。构建上下文使用允许列表，最终镜像只保留运行代码/依赖和构建元数据，不复制 .env、数据库、导出、.git、测试或凭据。

多阶段构建与服务配置依据：[Docker 多阶段构建](https://docs.docker.com/build/building/multi-stage/)、[Compose 服务参考](https://docs.docker.com/reference/compose-file/services/)。基础 Node 版本核对来源：[官方 Docker Node 22 Dockerfile](https://github.com/nodejs/docker-node/blob/main/22/bookworm-slim/Dockerfile)。

## 首次创建与运行

新卷必须显式初始化；已有坏库不被覆盖。已有本地数据需迁移时先跳到下一节，避免先创建占用目标路径的空库。

```powershell
docker @composeArgs run --rm --no-deps maintenance deploy:init
docker @composeArgs run --rm --no-deps maintenance deploy:preflight
docker @composeArgs up -d rsshub watcher
docker @composeArgs ps
docker @composeArgs logs --tail 100 watcher
docker @composeArgs run --rm --no-deps maintenance deploy:health
docker @composeArgs run --rm --no-deps maintenance ops:status
```

watcher 与 RSSHub 共享网络命名空间，因此 watcher.env 可继续使用 http://127.0.0.1:1200；watcher 不发布端口，RSSHub 仍只绑定宿主回环。维护和备份容器没有网络。不要另外给 watcher 配置 networks/ports 或把已有 RSSHub 服务换成另一个 Compose 项目却保留旧网络引用。[网络模式说明](https://docs.docker.com/reference/compose-file/services/#network_mode)。

Node 直接接收 SIGTERM，容器以非 root 用户运行、根文件系统只读。data 卷可写，SQLite/WAL 与 deployment-sessions 均保留于该卷。维护结果不依赖浏览器。操作入口见 [OPERATIONS.md](OPERATIONS.md)。

健康检查只读，不执行迁移、查询 X 或发送邮件。healthy 代表本地宿主、租约与近期来源观察正常；RSSHub 明确显示 unverified_snapshot，demo 显示 simulated。缺数据、陈旧、预算暂停、事故、构建/配置不匹配会显示不同原因。健康状态不能代替 productionReady。

## 从原本地库迁移

先通过原本地 ops:stop / Ctrl+C 停止宿主，并确认 runtime.active=false、没有发送中/运行中领取；处理 needs_attention 时沿用 B06 精确核对。随后：

```powershell
npm run ops:backup -- data/migrate-01.sqlite
# 记录返回的 sha256。目标卷中的 watcher.sqlite 必须尚不存在。
$importDirectory = (Resolve-Path -LiteralPath data).Path
docker @composeArgs run --rm --no-deps -v "${importDirectory}:/app/import:ro" maintenance ops:restore /app/import/migrate-01.sqlite /app/data/watcher.sqlite <sha256>
docker @composeArgs run --rm --no-deps maintenance deploy:preflight
docker @composeArgs up -d rsshub watcher
```

恢复只发布到新路径，不覆盖原文件。若目标已初始化，选择一个新的数据卷/路径，保留原卷。更换目标账号不会改写旧身份与通知。迁移后核对检查点、目标、预算和未决数量，再开始观察。

## 停止、更新与回滚

```powershell
docker @composeArgs stop watcher
docker @composeArgs run --rm --no-deps maintenance ops:status
docker @composeArgs run --rm --no-deps maintenance ops:backup /app/backups/before-upgrade-01.sqlite
```

stop_grace_period 为 330 秒，覆盖本程序最长 300 秒停止宽限；如果仍发生强停，记录保持未决，不自动重发。[停止宽限说明](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)。

升级前记录提交、构建 sourceHash/lockHash、镜像 ID、schema、配置 revision 和备份哈希。先停 watcher，再更新 RSSHub/Redis 和 watcher，避免共享网络指向已替换的 RSSHub。构建新镜像，执行显式 init/迁移与 preflight，重新启动并检查健康与未决记录。升级不会自动选择真实模型、启用 live 或修改旧通知。

Linux 同一容器重启时会复用 PID 1。本版记录内核启动/进程启动标识；只有相同记录宿主且能证明旧进程身份已消失时才重新取得执行权。发送中记录仍隔离为 needs_attention。证明缺失、旧版记录或其他宿主保持保守阻止，不能只凭 PID 或租约到期解锁。

回滚先停止新实例；使用升级前已记录的镜像和停机备份恢复到新卷/新路径，确保只启用一个活动副本。新 schema 不能交给不支持它的旧代码。运行期间取得的备份可能带有旧执行权/未决状态，恢复后可先只读查看和导出；无法证明原宿主停止时不得直接激活或清空领取。正常回滚使用停止后制作的恢复点。

## 可选每日备份

```powershell
docker @composeArgs --profile backups up -d backups
docker @composeArgs logs --tail 100 backups
docker @composeArgs --profile backups stop backups
```

backups 不挂载 Cookie 或 watcher 配置密钥，没有网络，只访问 data / backups 两个卷。首次启动立即生成一致性备份，然后按单调时间每 24 小时执行；失败最多每 15 分钟重试，连续失败只记录一次失败，恢复再记录一次。停止等待当前快照发布完成。输出仅含状态、schema、字节数和校验和。

保留期由用户管理，程序不自动删除备份。定期核对磁盘容量并用新路径做恢复演练。导出需要带走的备份可使用 Docker 的受控文件复制/卷挂载；不要直接复制仍运行的 SQLite 主文件而遗漏 WAL。

## 验收与发布检查

```powershell
npm run acceptance:offline
npm run acceptance:capacity
# 也可精确指定新报告路径；避免 PowerShell 对 npm 额外参数的转发差异
npm run build
node scripts/acceptance.mjs --output data/acceptance/reviewed.json --benchmark
npm run release:check
# 容器中使用 maintenance release:check /app/backups/offline.json
```

报告包含构建、测试集哈希、20 项场景映射、合成时效和可选容量实测。release:check 可接收一份匹配当前 sourceHash、锁文件、版本与提交的干净构建报告，更新相应离线门槛；退出码 2 代表生产门槛未满足。缺失/旧报告、未运行真实验收不能被当作通过。

真正上线仍需同一构建/配置的至少 48 小时 preview、来源完整性解释、真实模型质量/费用和受控邮件送达验收。RSSHub 的未验证覆盖不会因运行满 48 小时变成完整覆盖。本版 release 检查始终保留 live_adapter 阻断；没有启用真实 agent。
