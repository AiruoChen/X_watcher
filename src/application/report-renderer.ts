import type { ReportRenderer } from '../domain/ports.js';
import type { ReportView, SemanticAnalysis } from '../domain/model.js';
const statuses: Record<string, string> = { released: '已发布', rolling_out: '逐步开放', planned: '计划', speculation: '推测', discussion: '讨论' };
const changeLabels = { late: '迟到内容', edited: '编辑/更正', deleted: '来源明确标记删除', analysis_updated: '分析补充/更新', removed: '已不在原日期窗口，未推断删除' };
const clip = (text: string, length: number): string => text.length > length ? text.slice(0, length) + '…' : text;
export class ReportTextRenderer implements ReportRenderer {
  render(view: ReportView): string {
    const lines = ['@' + view.handle + ' · ' + view.window.day, '时区：' + view.timeZone,
      '范围：' + view.window.from + '（含）至 ' + view.window.to + '（不含）',
      view.kind === 'addendum' ? '历史补充：以下变更属于原报告日期，不计入昨日新帖。'
        : view.kind === 'partial' ? '部分报告：仅展示已收集内容，可能有遗漏。'
        : view.window.day < view.issuedOn ? '离线补报' : '昨日内容概览',
      !view.sourceComplete ? '来源覆盖不完整/未验证，不能视为完整日报。' : '来源查询覆盖完整报告窗口。',
      !view.analysisComplete ? '部分内容待分析或正文不完整；未验证部分仅显示原文摘录。' : '内容依据作者推文及已保存分析，未独立核实。',
      '生成/入队时间：' + view.generatedAt + '；实际发送时间以邮件头和投递记录为准。', ''];
    const wanted = view.kind === 'addendum' ? new Set(view.changes.map(c => c.postId)) : null;
    if (wanted) for (const c of view.changes) lines.push('- ' + changeLabels[c.kind] + '：' + c.postId);
    const items = view.items.filter(x => !wanted || wanted.has(x.post.id));
    lines.push('内容与来源（本地快照共 ' + view.items.length + ' 条，本邮件最多展示 100 条）');
    for (const { post, result } of items.slice(0, 100)) {
      lines.push('', post.deleted ? '来源明确标记删除：' + post.id : result ? clip(result.analysis.summary, 800)
        : '【待分析 · 原文摘录】' + clip(post.text, 600));
      if (!post.deleted && result) {
        const a = result.analysis as Partial<SemanticAnalysis>;
        if (a.updates) for (const u of a.updates.slice(0, 8)) lines.push('  ' + u.product + ' · ' + (statuses[u.status] ?? u.status) + '：' + clip(u.text, 300));
        else for (const update of result.analysis.chatgptUpdates.slice(0, 8)) lines.push('  ChatGPT（据作者说法）：' + clip(update, 300));
        if (a.resetFinding && a.resetFinding.kind !== 'none') {
          const r = a.resetFinding;
          lines.push('  重置信息：' + (r.kind === 'correction' ? '更正' : r.kind === 'discussion' || a.resetDetails?.certainty !== 'confirmed' ? '待确认' : '作者公告'),
            '  原文时间：' + (r.whenText ?? '未知') + '；时区：' + (r.timeZoneText ?? '未知'),
            '  北京时间：' + (r.normalizedAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'long' }).format(new Date(r.normalizedAt)) : '未知'));
        }
        if (post.completeness !== 'full') lines.push('  正文完整性未确认；以上分析仅基于已收集文本。');
      }
      lines.push('发布时间：' + post.publishedAt, '来源：' + post.url);
    }
    lines.push('', '作者关于重置的声明不代表你的实际账户额度已恢复。');
    const text = lines.join('\n');
    return text.length > 90000 ? text.slice(0, 89850) + '\n[正文过长已截断；完整版本与条目保存在本地报告快照。]' : text;
  }
}
