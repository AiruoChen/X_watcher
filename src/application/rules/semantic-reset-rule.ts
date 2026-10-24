import type { NotificationRule } from '../../domain/ports.js';
import type { AnalyzedPost, Notification, SemanticAnalysis } from '../../domain/model.js';
export class SemanticResetRule implements NotificationRule {
  readonly id = 'semantic-reset'; readonly version = 'v1';
  evaluate(item: AnalyzedPost, recipient: string, now: string): readonly Notification[] {
    const a = item.analysis as Partial<SemanticAnalysis>, finding = a.resetFinding, details = a.resetDetails;
    if (a.schemaVersion !== 1 || !finding || finding.kind === 'none' || !details || !['chatgpt','codex','api'].includes(details.product)) return [];
    const partial = a.inputCompleteness === 'partial';
    const label = finding.kind === 'correction' ? '重置信息更正'
      : partial || details.certainty === 'uncertain' || finding.kind === 'discussion' ? '待确认的重置讨论' : '重置公告';
    const beijing = finding.normalizedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
      dateStyle: 'full', timeStyle: 'long' }).format(new Date(finding.normalizedAt)) : '无法无歧义转换，请核对原文';
    return [{ id: 'semantic-reset:' + item.post.targetId + ':' + item.post.id, kind: finding.kind === 'correction' ? 'correction' : 'reset',
      targetId: item.post.targetId, recipient, subject: '[' + details.product + '] ' + label, createdAt: now,
      text: [label, a.summary, '适用人群：' + (details.audience ?? '未知'), '重置时间（原文）：' + (finding.whenText ?? '未知'),
        '时区（原文）：' + (finding.timeZoneText ?? '未知'), '北京时间：' + beijing,
        '推文发布时间：' + item.post.publishedAt, '发现时间：' + ((item.post as { discoveredAt?: string }).discoveredAt ?? '未知'), '处理时间：' + now,
        '更正关联帖子：' + (details.previousPostId ?? '原文未说明'), '依据：' + finding.evidence,
        '来源：' + item.post.url, partial ? '正文完整性未知，仅基于已收集的作者文字。' : '',
        '这是作者的声明/讨论，不代表你的账户额度已恢复。'].filter(Boolean).join('\n') }];
  }
}
