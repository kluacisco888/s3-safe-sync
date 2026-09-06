export class LocalStateChangedError extends Error {
  constructor(path: string) {
    super(`Local file changed during synchronization: ${path}`);
    this.name = "LocalStateChangedError";
  }
}
