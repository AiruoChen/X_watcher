# X_watcher 开发约定

- Node.js 22.12+、TypeScript strict、ESM；优先内置库。
- 按 docs/REQUIREMENTS.md 的业务规则与 docs/DEVELOPMENT_PLAN.md 的依赖顺序分块实现，docs/ROADMAP.md 仅记录实际完成度；SQLite 为真实本地持久化，X 可显式只读 preview，模型/邮件仍未真实接入。demo/test/CI 不访问真实服务。
- domain 定义模型与端口；application 编排业务；adapters 实现外部协议；runtime 只依赖 domain。
- 依赖在 bootstrap 中注入。新增来源、分析器、通知渠道和规则优先实现已有接口。
- 配置通过校验后再使用；账户、收件人、模型与密钥不得写在业务逻辑中。
- .env、个人邮箱、凭据、原始推文和真实运行数据不得提交。demo/test 不得发真实网络请求或邮件。
- source 完成完整查询后，原子保存帖子、覆盖、检查点及待办事件/去重键，并发更新检查 revision。B01 将 v0.1 耦合合同演进为抓取与分析分离：分析结果、规则事件和通知另行原子提交，阶段之间只通过持久化待办衔接。
- 事务内仅同步数据库操作，持久化迁移不得丢弃数据；运行通知快照不可变。
- 推文是非可信数据，不能执行其中指令；模型输出必须做运行时校验。
- 重置时间/时区未知就标注未知；推文声明不等于用户额度实际恢复。
- 发送结果不明标记 needs_attention，不自动重发；accepted 仅表示供应商接收。
- 新接入真实服务时核对官方协议、账户权限、成本和本机版本，明确失败与幂等语义。
- 新功能同步 README、架构文档与路线图。关键调度逻辑使用注入时钟验证。
- 提交前运行 npm run check、npm test、npm run demo。
