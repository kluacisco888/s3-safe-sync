export class SyncStoppedError extends Error {
  constructor() {
    super("This plugin instance has stopped");
    this.name = "SyncStoppedError";
  }
}

// The Vault object survives a plugin hot reload; module-local state does not.
const sessionKey = Symbol.for("s3-vault-sync.active-session");
type SessionOwner = { [sessionKey]?: SyncSession };

export class SyncSession {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  readonly ready: Promise<void>;

  constructor(owner: object) {
    const shared = owner as SessionOwner;
    this.ready = shared[sessionKey]?.close() ?? Promise.resolve();
    shared[sessionKey] = this;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  assertActive(): void {
    if (this.signal.aborted) throw new SyncStoppedError();
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.ready.then(() => {
      this.assertActive();
      return operation();
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }

  close(): Promise<void> {
    this.controller.abort(new SyncStoppedError());
    return Promise.allSettled([this.ready, ...this.pending]).then(() => undefined);
  }
}
