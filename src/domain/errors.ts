export class RevisionConflictError extends Error {
  constructor() { super('Checkpoint revision changed; poll was not committed.'); }
}
export class IncompleteBatchError extends Error {
  constructor() { super('Source retrieval incomplete; checkpoint was not advanced.'); }
}
