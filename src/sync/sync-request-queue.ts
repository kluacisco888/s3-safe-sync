export interface SyncRequestOptions {
  allowBulkDeletion?: boolean;
  fullHashAudit?: boolean;
}

export class SyncRequestQueue {
  private allowBulkDeletion = false;
  private exclusiveTail: Promise<void> = Promise.resolve();
  private fullHashAudit = false;
  private pending = false;
  private running: Promise<void> | undefined;

  constructor(
    private readonly run: (
      allowBulkDeletion: boolean,
      fullHashAudit: boolean,
    ) => Promise<void>,
  ) {}

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  request(options: SyncRequestOptions = {}): Promise<void> {
    this.pending = true;
    this.allowBulkDeletion ||= options.allowBulkDeletion === true;
    this.fullHashAudit ||= options.fullHashAudit === true;
    if (this.running) {
      return this.running;
    }
    this.running = this.runExclusive(() => this.drain());
    return this.running;
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.exclusiveTail.then(operation, operation);
    this.exclusiveTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        this.pending = false;
        const allowBulkDeletion = this.allowBulkDeletion;
        const fullHashAudit = this.fullHashAudit;
        this.allowBulkDeletion = false;
        this.fullHashAudit = false;
        await this.run(allowBulkDeletion, fullHashAudit);
      }
    } finally {
      this.running = undefined;
    }
  }
}
