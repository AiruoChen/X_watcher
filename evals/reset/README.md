# 重置语义评估

60 条公开合成文本：36 条相关公告/讨论/更正、24 条困难负例；包含中英文、没有 reset 的额度恢复、密码/设备/代码重置、否定、提示注入、相对日期、模糊时区和无效日期。不是实际推文。

运行 `npm run eval:reset` 只检查样本规模并输出 `not_run`。目前未选择模型，没有准确率结论。
后续模型适配器应逐条读取 text，按 StructuredModel 的 schema 输出对象，保存到忽略目录，例如 `data/eval-outputs.json`：

```json
[{"id":"positive-1","output":{"postId":"positive-1","summary":"…","topics":[],"updates":[],"reset":null}}]
```

必须包含全部 60 条且 ID 唯一。每条预期标签含 kind/product/certainty；确定公告是 announcement + confirmed（讨论为 uncertain），只有产品也正确时才算确定公告命中。执行 `npm run eval:reset -- data/eval-outputs.json`，主门槛为 confirmedPrecision≥90%、confirmedRecall≥95%、无无效输出、零时间误推断；缺少任何确定公告预测时 precision=null、判定失败。全量输出 uncertain 即使 relatedRecall=100% 也不能通过。

relatedPrecision/relatedRecall 仅统计广义相关性，不代替确定公告指标；kindErrors、productErrors、certaintyErrors 独立输出供验收核对。任何无效输出都会失败，不能漏交样本来提高分数。数据集至少 60 条、相关正例 20 条、困难负例 20 条且包含确定公告。预期标签仅用于评估，不作为模型输入。
单元测试中的标签输出仅验证评估器/规则合同，不代表任何真实模型识别能力。加入新模型前应独立扩充样本、人工核对并留存模型/提示版本。
