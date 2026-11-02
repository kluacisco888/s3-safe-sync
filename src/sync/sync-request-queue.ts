// 完整校验的来源：true 是用户主动要求的（全部重读）；"automatic" 是自动发起的（如 Head 冲突后的重试），
// 可以沿用这次加载期间真读过的指纹
export type FullHashVerificationRequest = boolean | "automatic";

export interface SyncRequestOptions {
  allowBulkDeletion?: boolean;
  fullHashVerification?: FullHashVerificationRequest;
}

export interface SyncRunOptions {
  allowBulkDeletion: boolean;
  fullHashVerification: FullHashVerificationRequest;
}

export class SyncRequestQueue {
  private allowBulkDeletion = false;
  private exclusiveTail: Promise<void> = Promise.resolve();
  private fullHashVerification: FullHashVerificationRequest = false;
  private pending = false;
  private running: Promise<void> | undefined;

  constructor(private readonly run: (options: SyncRunOptions) => Promise<void>) {}

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  request(options: SyncRequestOptions = {}): Promise<void> {
    this.pending = true;
    this.allowBulkDeletion ||= options.allowBulkDeletion === true;
    // 合并排队的请求时，用户主动的完整校验优先于自动的
    if (options.fullHashVerification === true) {
      this.fullHashVerification = true;
    } else if (options.fullHashVerification === "automatic") {
      this.fullHashVerification ||= "automatic";
    }
    if (this.running) {
      return this.running;
    }
    this.running = this.runExclusive(() => this.drain());
    return this.running;
  }

  requestPeriodic(headRetryScheduled: boolean): Promise<void> {
    if (headRetryScheduled) {
      return Promise.resolve();
    }
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
