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

// 列表里的一个对象：LastModified 原样保留 S3 给的文本，Size 是字节数
export interface ListedObject {
  key: string;
  lastModified: string;
  size: number;
}

export interface ObjectStore {
  delete(key: string): Promise<void>;
  get(
    key: string,
    options?: ObjectGetOptions,
  ): Promise<StoredObject | undefined>;
  list(prefix: string): Promise<string[]>;
  // 与 list 相同的范围，另带 LastModified 和大小；列表不完整或有一项读不懂就抛错，绝不返回一部分
  listObjects(prefix: string): Promise<ListedObject[]>;
  put(
    key: string,
    body: Uint8Array,
    options?: ObjectPutOptions,
  ): Promise<StoredObject>;
}

export class ObjectPreconditionError extends Error {
  readonly code = "OBJECT_PRECONDITION_FAILED" as const;

  constructor() {
    super("条件写入完成前对象已被改动");
    this.name = "ObjectPreconditionError";
  }
}
