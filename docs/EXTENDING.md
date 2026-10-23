# 扩展指南

本页介绍当前框架的接口替换方式。完整生产实现按 [开发计划](DEVELOPMENT_PLAN.md) 的 B01–B09 推进，目标规则见 [需求文档](REQUIREMENTS.md)。B01 已完成抓取/分析合同演进，新增存储应实现 ports/store.ts 并复用 tests/contracts/watch-store.contract.ts。

## 添加来源

在 `src/adapters/source/` 实现 `PostSource`，在组合根注册 provider -> adapter 映射，配置目标使用对应 provider。应用不解析来源游标。真实来源需要处理分页、限流、超时、初始回溯和账号验证。返回不完整批次不能推进检查点。首版 config 的环境变量解析针对 X；添加 RSS 时扩展配置解析为 provider + target 结构即可，不必改调度器。

## 添加分析服务

实现 `ContentAnalyzer.analyze(Post)`。把外部响应的 unknown JSON 校验成 `Analysis`，再返回。不得只用 TypeScript 类型断言代替运行时校验。将来源内容隔离为非可信文本，不允许原文修改系统提示、收件人或工具权限。model/key 从配置注入，不写死在业务层。

## 添加提醒规则

在 `src/application/rules/` 实现 `NotificationRule`，设置稳定且唯一的 `id`，在组合根 rules 数组中注册。通知 ID 建议 `<rule>:<target>:<post>`，使重复查询/重试不会重复通知。规则是纯计算，不发信、不操作数据库。例如未来可以增加价格变动、模型发布或关键词提醒。

## 添加通知渠道

实现 `NotificationChannel.send`。快照传入收件人、标题、正文与 ID。准确区分 accepted / rejected / unknown；超时不能当作明确失败。使用供应商幂等键时必须记录其有效窗口，超过窗口的不明请求不能盲目重试。增加新渠道时可扩展通知目的地为 tagged union，迁移旧快照并补契约测试。

## 添加持久化存储

现有 `SqliteStore` 已实现 `WatchStore`。新增数据库时复用同一套合同测试：checkpoint/posts/outbox 原子提交、revision 冲突无部分写入、读取不泄露可变引用、claim 互斥、发送状态恢复。SQLite 的重启、迁移、损坏和跨进程测试位于 tests/persistence.test.ts；新增适配器也需覆盖这些场景。数据库事务只做同步操作。

## 接入生产运行

`createApplication` 目前明确拒绝 live，demo 也拒绝 capability=real 的适配器。生产发布前应增加独立 live 组合函数、持久化执行互斥、完整来源覆盖记录、退避与速率限制、优雅停机、人工核对入口、离线摘要追赶、首次启动历史提醒策略。完成这些后才开放 live，不应简单删除保护检查。

## 新功能提交顺序

1. 更新领域模型/端口和 `docs/ROADMAP.md` 的目标。
2. 先使用模拟适配器与注入时钟验证业务语义。
3. 实现外部适配器，保留模拟模式，不把真实凭据带入测试。
4. 更新 README、架构与操作文档。
5. 运行 check / test / demo，审查兼容性后提交。
