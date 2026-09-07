import type { SyncProgress } from "../sync/sync-service";

export class SyncProgressThrottle {
  private renderedPathInPhase = false;
  private lastPhase: SyncProgress["phase"] | undefined;
  private lastRenderedAt: number | undefined;

  constructor(private readonly intervalMs = 100) {}

  reset(): void {
    this.renderedPathInPhase = false;
    this.lastPhase = undefined;
    this.lastRenderedAt = undefined;
  }

  shouldRender(progress: SyncProgress, now: number): boolean {
    const phaseChanged = progress.phase !== this.lastPhase;
    if (phaseChanged) {
      this.renderedPathInPhase = false;
    }
    const firstPathInPhase =
      progress.currentPath !== undefined && !this.renderedPathInPhase;
    const completed = progress.total > 0 && progress.completed >= progress.total;
    const elapsed =
      this.lastRenderedAt === undefined ||
      now - this.lastRenderedAt >= this.intervalMs;
    if (
      this.lastRenderedAt !== undefined &&
      !phaseChanged &&
      !firstPathInPhase &&
      !completed &&
      !elapsed
    ) {
      return false;
    }
    this.lastPhase = progress.phase;
    this.lastRenderedAt = now;
    this.renderedPathInPhase ||= progress.currentPath !== undefined;
    return true;
  }
}
