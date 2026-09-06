export interface SyncRequestOptions {
  allowBulkDeletion?: boolean;
}

export class SyncRequestQueue {
  private allowBulkDeletion = false;
  private pending = false;
  private running: Promise<void> | undefined;

  constructor(
    private readonly run: (allowBulkDeletion: boolean) => Promise<void>,
  ) {}

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  request(options: SyncRequestOptions = {}): Promise<void> {
    this.pending = true;
    this.allowBulkDeletion ||= options.allowBulkDeletion === true;
    if (this.running) {
      return this.running;
    }
    this.running = Promise.resolve().then(() => this.drain());
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        this.pending = false;
        const allowBulkDeletion = this.allowBulkDeletion;
        this.allowBulkDeletion = false;
        await this.run(allowBulkDeletion);
      }
    } finally {
      this.running = undefined;
    }
  }
}
