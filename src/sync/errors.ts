export class LocalStateChangedError extends Error {
  constructor(readonly path: string) {
    super(`Local file changed during synchronization: ${path}`);
    this.name = "LocalStateChangedError";
  }
}
