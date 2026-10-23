import type { EventSink } from '../../domain/ports.js';
import type { AppEvent } from '../../domain/model.js';
/** Events contain identifiers/counts only, never credentials, recipients, or post bodies. */
export class ConsoleEvents implements EventSink {
  record(event: AppEvent): void { console.log(JSON.stringify(event)); }
}
