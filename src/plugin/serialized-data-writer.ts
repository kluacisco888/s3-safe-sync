export class SerializedDataWriter<Value> {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly read: () => Value,
    private readonly write: (snapshot: Value) => Promise<void>,
  ) {}

  save(): Promise<void> {
    const writeLatest = (): Promise<void> =>
      this.write(structuredClone(this.read()));
    const run = this.tail.then(writeLatest, writeLatest);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
