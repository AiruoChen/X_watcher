import type { NotificationRule } from '../../domain/ports.js';
import type { AnalyzedPost, Notification } from '../../domain/model.js';

export class ResetRule implements NotificationRule {
  readonly id = 'reset';
  evaluate(item: AnalyzedPost, recipient: string, now: string): readonly Notification[] {
    const reset = item.analysis.reset;
    if (!reset) return [];
    return [{ id: `reset:${item.post.targetId}:${item.post.id}`, kind: 'reset',
      targetId: item.post.targetId, recipient, createdAt: now,
      subject: '发现重置相关推文',
      text: [item.analysis.summary, `重置时间（原文）：${reset.whenText ?? '原文未明确说明'}`,
        `时区（原文）：${reset.timeZoneText ?? '未知，请核对原文'}`,
        `推文发布时间：${item.post.publishedAt}`, `依据：${reset.evidence}`,
        `来源：${item.post.url}`, '这是推文信息提醒，不代表你的账户额度已经恢复。'].join('\n') }];
  }
}
