export interface StoredObject {
  body: Uint8Array;
  etag: string;
  lastModified: string;
  serverDate?: string;
}

export interface ObjectPutOptions {
  ifMatch?: string;
  ifNoneMatch?: boolean;
}

export interface ObjectGetOptions {
  revalidate?: boolean;
}

export interface ObjectStore {
  delete(key: string): Promise<void>;
  get(
    key: string,
    options?: ObjectGetOptions,
  ): Promise<StoredObject | undefined>;
  list(prefix: string): Promise<string[]>;
  put(
    key: string,
    body: Uint8Array,
    options?: ObjectPutOptions,
  ): Promise<StoredObject>;
}

export class ObjectPreconditionError extends Error {
  readonly code = "OBJECT_PRECONDITION_FAILED" as const;

  constructor() {
    super("The object changed before the conditional write completed");
    this.name = "ObjectPreconditionError";
  }
}
