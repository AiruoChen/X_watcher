import type { ExecutionContext, Waiter } from '../domain/ports.js';

export class TimerWaiter implements Waiter {
  wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
export class DeadlineContext implements ExecutionContext {
  constructor(readonly signal: AbortSignal, readonly canClaim: () => boolean = () => true) {}
  call<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = new AbortController();
      let settled = false;
      const finish = (result: { value: T } | { error: unknown }): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.signal.removeEventListener('abort', abort);
        if ('error' in result) { child.abort(); reject(result.error); } else resolve(result.value);
      };
      const abort = (): void => finish({ error: new Error('Operation cancelled; outcome may be unknown.') });
      const timer = setTimeout(() => finish({ error: new Error('Operation deadline exceeded; outcome may be unknown.') }), timeoutMs);
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) { abort(); return; }
      // Keep both handlers after timeout; late adapter results cannot reach the caller.
      Promise.resolve().then(() => { child.signal.throwIfAborted(); return operation(child.signal); })
        .then(value => finish({ value }), error => finish({ error }));
    });
  }
}
