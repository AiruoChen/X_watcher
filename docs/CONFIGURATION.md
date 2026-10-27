# 配置模块（B01）

入口保持 `src/config.ts`。`loadConfig(env)` 从传入环境中挑选受支持字段，验证结构/跨字段规则并检查非 demo 的凭据环境变量是否存在；不把凭据值写入返回对象。没有配置文件写入/热更新功能。

`parseConfig(unknown)` 接受字符串值组成的环境风格对象，可用于 JSON 载入后的校验。它拒绝未知字段、null、非法类型/数值/时区/邮箱以及未知 schema。`loadConfig` 则允许操作系统环境中存在无关变量。

```ts
import { loadConfig, parseConfig, describeConfig } from './src/config.js';
const defaults = loadConfig({});
const custom = parseConfig({ WATCH_HANDLES: 'thsottiaux', DAILY_DIGEST_AT: '08:00' });
console.log(describeConfig(custom)); // 不含邮箱、发件人、路径和密钥引用
```

运行 `npm run config:check` 检查被忽略的 `.env` 并输出脱敏摘要。错误仅含字段名，不回显非法值。`revision` 是规范化配置的 SHA-256 指纹；改变收件人/策略会改变指纹，轮换真实密钥值不会改变指纹。指纹不是可还原的配置备份。

## 已实现字段

所有默认值的单一代码来源为 `src/config/schema.ts`，复制 `.env.example` 可以得到完整模板。

| 分组 | 字段 | 默认/约束 |
| --- | --- | --- |
| 模式 | CONFIG_SCHEMA_VERSION / APP_MODE | 1 / demo；preview/live 能解析，当前启动仍明确拒绝 |
| 目标 | WATCH_HANDLES | thsottiaux；逗号分隔，不允许空项或大小写重复 |
| 时间 | POLL_INTERVAL_MINUTES / TIME_ZONE / DAILY_DIGEST_AT | 30 / Asia/Shanghai / 08:00；HH:mm 严格格式 |
| 收件人 | NOTIFICATION_TO | demo 为保留域占位地址；live 必须显式填写真实地址 |
| 存储 | STORAGE_KIND / DATABASE_PATH | memory / data/x-watcher.sqlite；外部模式要求 sqlite，但适配器已在 B02 实现，常驻启动组装在 B03 |
| 首次与提醒 | INITIAL_BACKFILL_DAYS / RESET_MAX_AGE_HOURS | 1 / 24 |
| 日报 | DIGEST_CATCH_UP_DAYS / MAX_CATCH_UP_EMAILS / DIGEST_GRACE_MINUTES | 7 / 3 / 15 |
| 健康 | FAILURE_THRESHOLD / STALE_AFTER_MINUTES | 3 / 90 |
| 保留 | POST_RETENTION_DAYS / AUDIT_RETENTION_DAYS | 90 / 180 |
| 重试 | RETRY_MAX_ATTEMPTS / RETRY_BASE_SECONDS / RETRY_MAX_SECONDS / RETRY_JITTER | 5 / 30 / 1800 / 0.2 |
| 服务 | SOURCE_PROVIDER / ANALYSIS_PROVIDER / MAIL_PROVIDER | 默认未选；没有硬编码供应商 |
| 凭据 | SOURCE_CREDENTIAL_ENV / ANALYSIS_CREDENTIAL_ENV / MAIL_CREDENTIAL_ENV | 环境变量名称，例如 X_API_TOKEN，绝不是密钥本身 |
| 分析 | ANALYSIS_MODEL / ANALYZER_VERSION / PROMPT_VERSION | 未选型号 / fixture-v1 / v1 |
| 发件 | MAIL_FROM | 可选裸邮箱地址；live 必填 |
| 超时 | SOURCE_TIMEOUT_SECONDS / ANALYSIS_TIMEOUT_SECONDS / MAIL_TIMEOUT_SECONDS | 30 / 120 / 30 |
| 预算 | MAX_CALLS_PER_DAY / MAX_COST_PER_DAY | 空表示未设置；若填写必须为正数，调用数为整数 |

跨字段规则：最大退避不得小于基础退避；正文保留期覆盖初始回溯、补报日期加一天和重置时效；审计保留期不短于正文。所有数值有上限，不接受 NaN/Infinity/指数或十六进制写法。

preview 要求来源/分析供应商、型号、凭据引用与 SQLite 配置；live 还要求发信服务、发件邮箱、凭据引用与显式收件地址。通过配置校验不表示真实功能已可运行，bootstrap 仍拒绝 preview/live。

## 策略与执行的区别

B01 已消费：目标、时区、日报时间、初始回溯、提醒最大时效、分析器/提示版本、分析重试及配置快照。

B01 仅声明并校验：补报/宽限/事故阈值、外部超时、真实服务、生产启动组装、预算和自动清理。这些执行能力分别在 B02–B09 完成；设置字段不会提前启用它们。

demo 与 CI 不读取真实凭据去调用外部服务。收件人仅出现在本地配置/不可变通知中，`describeConfig` 与常规事件不输出它。
