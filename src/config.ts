import type { RuntimeConfig } from './domain/model.js';

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const mode = env['APP_MODE'] ?? 'demo';
  if (mode !== 'demo' && mode !== 'live') throw new Error('APP_MODE must be demo or live.');
  const handles = (env['WATCH_HANDLES'] ?? 'thsottiaux').split(',').map(value => value.trim().replace(/^@/, ''));
  if (!handles.length || handles.some(value => !/^[A-Za-z0-9_]{1,15}$/.test(value))
    || new Set(handles.map(value => value.toLowerCase())).size !== handles.length) {
    throw new Error('WATCH_HANDLES must contain unique X usernames.');
  }
  const minutes = Number(env['POLL_INTERVAL_MINUTES'] ?? '30');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Invalid poll interval.');
  const timeZone = env['TIME_ZONE'] ?? 'Asia/Shanghai';
  new Intl.DateTimeFormat('en', { timeZone }).format(new Date(0));
  const dailyDigestAt = env['DAILY_DIGEST_AT'] ?? '08:00';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyDigestAt)) throw new Error('DAILY_DIGEST_AT must be HH:mm.');
  const recipient = env['NOTIFICATION_TO'] ?? 'reader@example.invalid';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error('Invalid notification recipient.');
  return { mode, targets: handles.map(handle => ({ id: `x:${handle.toLowerCase()}`, provider: 'x', handle })),
    pollIntervalMs: minutes * 60_000, timeZone, dailyDigestAt, recipient };
}
