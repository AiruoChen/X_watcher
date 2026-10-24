# B05：分析与重置识别（v0.7.1）

已实现供应商无关接口、结构化解析、重置规则、版本化重分析与离线验证。用户选择暂不指定服务商，因此没有真实模型客户端、网络请求或真实准确率结论。现有 RSSHub source-only preview 仍只抓取。

## 代码和扩展点

| 入口 | 职责 |
| --- | --- |
| `domain/ports/analysis.ts` | `StructuredModel.complete(request, signal)`；明确 simulated/real，区分 complete/refused/incomplete |
| `adapters/analysis/structured-contract.ts` | 提示词及 JSON Schema；推文只作非可信数据 |
| `adapters/analysis/structured-analyzer.ts` | 注入模型客户端、哈希器和配置；校验输出、保存模型/提示/分析器版本和输入哈希 |
| `domain/policies/semantic-analysis.ts` | 产品、发布状态、精确引用、可证明的时间转换 |
| `application/rules/semantic-reset-rule.ts` | 公告/待确认/更正提醒，产品、人群、原文、北京时间和来源 |
| `application/reanalyze-post.ts` | 显式新版本重分析，固定 emitNotifications=false |
| `bootstrap-analysis-mail.ts` | 依赖组装；demo 拒绝真实分析客户端 |
| `evals/reset/` | 60 条合成语义样本和候选输出评估器 |

未来适配器只负责外部协议，不能修改收件人、作业版本或直接发送邮件。客户端返回的 output 必须是已解析的对象；拒绝、截断和无效 JSON 应如实标记，不能补造成成功。遵守 signal，清理超时请求，不把密钥/服务响应写入日志。提供模型访问权限和费用语义后才加入具体 SDK/HTTP 实现。

## 输出合同

根对象必须恰好包含 `postId, summary, topics, updates, reset`。updates 分开记录 chatgpt/codex/api/other，以及 released/rolling_out/planned/speculation/discussion。仅 ChatGPT 条目进入兼容字段 chatgptUpdates，保留发布状态。

reset 为 null 或包含 `kind, product, certainty, evidence, whenText, timeZoneText, audience, previousPostId` 的对象。讨论必须 uncertain；非额度产品不能产生提醒。证据、时间、人群、时区必须逐字出现在作者正文；更正 ID 必须出现在正文或已验证的来源编辑历史中，无法证明时留 null。应用层通过 previousPostVersion 查找同来源/作者/目标的既存前驱：优先明确引用，其次编辑历史或同帖版本；禁止关联未来才入库的版本。correctionLink 保存旧 postKey、来源 ID、URL 和依据，事件及通知保存 supersedesPostKey。分析提交事务会重验关联，旧通知保持不变。原文未写旧 ID 时仍可从可信版本链建立关联；本地找不到旧版本就明确显示无法核对，不猜“最新帖子”。规则版本升至 v2。

时间转换使用 domain/policies/reset-time.ts 的确定性语法：支持带偏移的 ISO、完整年月日数字日期、中英文月份日期、24 小时制/AM-PM/中文时刻，配合原文明确的 UTC/GMT、数值偏移、北京时间或 IANA 时区。例如 `3 January 2026 at 09:00 UTC` 转为北京时间 17:00，`2026年1月3日下午3点30分 北京时间` 转为 UTC 07:30。日期与时区证据可以分别引用，冲突则不转换。

不使用系统默认时区或 Date.parse 的自然语言猜测。IANA 时区通过本地钟面反查：夏令时重复时刻和不存在的时刻保持未知；tomorrow、今晚、周五、PST、缺日期/时区或 03/04 这类歧义日期仍为 null。模型不能提供自算的 normalizedAt，存储校验会从原文重新计算。

证据包含于正文只能证明引用真实，不能证明分类正确；真实模型仍需评估。当前提示不授予模型工具、环境变量、收件配置或执行权限。

## 配置与接入示例

保留本地 `ANALYSIS_PROVIDER=deferred` 即可继续只抓取，无须配置密钥。将来选择服务后使用已有 ANALYSIS_PROVIDER、ANALYSIS_MODEL、ANALYSIS_CREDENTIAL_ENV、ANALYZER_VERSION、PROMPT_VERSION、ANALYSIS_TIMEOUT_SECONDS。新增 `ANALYSIS_ALLOW_PARTIAL=false`。

```ts
const analyzer = createAnalysisModule(config, injectedModelClient, hasher);
const process = new ProcessAnalysis(analyzer, store, [new SemanticResetRule()], clock, config);
await process.execute(target, executionContext);
// 升级时显式新建作业，不能改旧作业的版本：
new ReanalyzePost(store, nextVersionConfig).execute(savedPostKey);
```

executionContext 提供统一超时/取消和宿主执行权；直接调用低层 complete 不提供应用层超时或预算。预算执行仍属 B08。

RSSHub 的 unknown/truncated 正文默认不分析。显式开启部分分析后，保留 inputCompleteness=partial，并使用“待确认”文案。此配置不会改写来源为 full、不会证明整天覆盖、不会把既有 preview 作业改成可发信。现有源只读入口不自动加载新分析器；可注入模块的全流程参考 `src/modules-demo.ts`。

作业版本和分析器版本不符会进入 needs_attention；新版本通过 ReanalyzePost 创建。相同版本重复排队返回原作业，不复活已完成/待核对作业。需要重试旧版本的持久失败时使用新版本标识。历史/过期过滤同时检查发现时间与实际处理时间。

## 验证

`npm run modules:demo` 完全离线演示抓取、分析、通知、不明发送和回执核对。
`npm run eval:reset` 返回样本规模及 not_run；实际候选输出评估见 [评估说明](../../evals/reset/README.md)。
单元测试涵盖伪造证据、输出截断、取消、产品区分、时间未知、部分正文、重分析不重发及延迟处理过滤。真实模型质量、调用成本和服务协议待服务商确定后验证。
