export interface SyncRequestOptions {
  allowBulkDeletion?: boolean;
  fullHashVerification?: boolean;
}

export interface SyncRunOptions {
  allowBulkDeletion: boolean;
  fullHashVerification: boolean;
}

export class SyncRequestQueue {
  private allowBulkDeletion = false;
  private exclusiveTail: Promise<void> = Promise.resolve();
  private fullHashVerification = false;
  private pending = false;
  private running: Promise<void> | undefined;

  constructor(private readonly run: (options: SyncRunOptions) => Promise<void>) {}

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  request(options: SyncRequestOptions = {}): Promise<void> {
    this.pending = true;
    this.allowBulkDeletion ||= options.allowBulkDeletion === true;
    this.fullHashVerification ||= options.fullHashVerification === true;
    if (this.running) {
      return this.running;
    }
    this.running = this.runExclusive(() => this.drain());
    return this.running;
  }

  requestIfIdle(): Promise<void> {
    return this.running ?? this.request();
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
        const fullHashVerification = this.fullHashVerification;
        this.allowBulkDeletion = false;
        this.fullHashVerification = false;
        await this.run({ allowBulkDeletion, fullHashVerification });
      }
    } finally {
      this.running = undefined;
    }
  }
}
