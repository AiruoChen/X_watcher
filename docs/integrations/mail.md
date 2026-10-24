# B06：邮件与核对（v0.7）

已实现供应商无关 MailTransport、EmailChannel、持久化尝试、只读核对、显式处理及离线测试。当前未选择邮件服务商，没有真实发信、供应商查询或 webhook 服务。`live` 仍由主程序拒绝启动。

## 接口

- `MailTransport.send(notification, binding, signal)`：发送不可变快照。成功必须返回 accepted 和非空 providerId；只有协议已证明未接收时，才返回 rejected 与 definitelyNotAccepted=true。其他结果、异常、取消均为 unknown。
- 可选 `lookup(binding, providerId, signal)`：按保存的供应商/账号/消息 ID 查询；原响应丢失时只允许精确幂等键查询。没有这项能力就保持待核对，不搜索“最近邮件”。
- `EmailChannel`：检查发件身份、收件/主题/正文、幂等窗口及结果；直接 send 被拒绝，发送必须经过 DeliverNotifications 的持久领取。
- `ReconcileNotification.execute(id)`：只读查询，返回 revision、attemptId、receipt。
- `ResolveNotification.execute(command)`：显式应用回执或人工结论。SQLite 在同一事务重验版本、当前尝试、状态和执行权，并保存状态与审计。

未来适配器必须核对官方协议的幂等范围/有效期、账号与发件身份、查询能力和明确拒绝语义。供应商没有幂等或回执功能时，不能凭接口名声称它有。暂未实现具体 SMTP/HTTP 或回执签名验证；网络 webhook 不能直接调用 resolve，需先由未来适配器验证真实性。

## 持久状态

领取前通知为 pending；领取和 attempt/binding 同事务落盘，随后才能调用供应商。

| 结果 | 状态与后续 |
| --- | --- |
| 带 ID 的 accepted | provider_accepted；不代表 delivered |
| 明确未接收 | failed；当前保守地只允许显式处理后重试 |
| 超时、取消、响应丢失、进程恢复 | needs_attention；禁止自动重发 |
| 精确核对 accepted / delivered / bounced | 显式 apply_receipt 后更新 |
| not_found / unknown | 不足以证明没发出；不改状态 |
| 人工 confirm_sent | provider_accepted，不伪造送达证据 |
| 人工 confirm_not_sent_retry | pending；需原因、revision、attemptId 且未超次数 |
| 人工 abandon | failed，留下审计 |

人工重试本身不发邮件；之后必须由允许发送的运行流程消费。发送尝试保留原始结果，人工确认不会把旧 unknown 改成 accepted。重复/过时回执用 revision 拒绝。sending 期间禁止人工处理。

binding 保存 provider、account、from、稳定 idempotencyKey、expiresAt、maxAttempts；不保存凭据。后续重试沿用原绑定，配置变更不能改账号或延长窗口。过期/上下文不符时不调用客户端，并保留待处理状态。schema 3 的旧尝试没有绑定时，不能自动猜测供应商查询；人工确认/放弃仍可用。

## 配置

| 字段 | 默认及含义 |
| --- | --- |
| MAIL_PROVIDER / MAIL_FROM | 空；未来显式配置，与注入客户端一致 |
| MAIL_ACCOUNT | 空；非秘密稳定账号标识，必须与注入客户端一致 |
| MAIL_CREDENTIAL_ENV | 只存未来密钥的环境变量名 |
| MAIL_IDEMPOTENCY_TTL_SECONDS | 0；未声明供应商幂等期限，不能依此自动重发；非零范围 1–604800 |
| MAIL_MAX_ATTEMPTS | 5；1–100，仅限制明确授权的重试 |
| MAIL_TIMEOUT_SECONDS | 30；由 ExecutionContext 应用 |

`createMailModule(config, transport, clock, hasher)` 拒绝在 demo/preview 加载 real 邮件客户端。改变配置不修改已生成的正文、收件人、发送身份或历史尝试。`.env.example` 只有占位字段，本地真实密钥不进 Git。

## 本地操作

必须配置已有 SQLite 路径；命令不会创建新库，也不会发送邮件；仅校验配置结构，不要求在线服务密钥存在。若运行宿主持有执行权，先正常停止宿主后再处理，避免与运行中的投递竞争。

```powershell
npm run mail:status -- <notificationId>
npm run mail:resolve -- <notificationId> <attemptId> <revision> confirm_sent operator "已在供应商后台核实"
npm run mail:resolve -- <notificationId> <attemptId> <revision> confirm_not_sent_retry operator "已核实未接收，允许再次尝试"
npm run mail:resolve -- <notificationId> <attemptId> <revision> abandon operator "决定停止此通知"
```

status 只输出状态、版本、尝试标识和审计数量，不输出邮箱或正文。尚无供应商查询 CLI，因为尚未选择服务商；应用层核对接口和模拟客户端已可使用。程序化回执处理示例见 `src/modules-demo.ts`。

数据库迁移到 schema 4，添加 notifications.revision 与邮件审计索引；升级前保留经校验的备份。测试覆盖 v3 旧未知邮件、双连接竞争、断连、恢复、幂等过期、错误账号/消息 ID、重复回执和审计重开。
