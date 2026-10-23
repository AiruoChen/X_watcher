/** Entirely synthetic protocol fixtures; never copied from a real account or API response. */
export const author = { data: { id: '100', username: 'thsottiaux', protected: false } };
export const post = (postId = '200', extra: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  id: postId, author_id: '100', created_at: '2026-01-01T12:00:00Z', text: `Synthetic update ${postId}`, ...extra,
});
export const page = (data: readonly unknown[] = [], next?: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  ...(data.length ? { data } : {}), meta: { result_count: data.length, ...(next ? { next_token: next } : {}) }, ...extra,
});
