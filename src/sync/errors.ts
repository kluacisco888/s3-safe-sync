export class LocalStateChangedError extends Error {
  constructor(readonly path: string) {
    super(`同步过程中本地文件被改动：${path}`);
    this.name = "LocalStateChangedError";
  }
}
