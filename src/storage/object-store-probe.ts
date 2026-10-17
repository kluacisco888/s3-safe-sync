import { ObjectPreconditionError, type ObjectStore } from "./object-store";

const normalizePrefix = (prefix: string): string =>
  prefix.replace(/^\/+|\/+$/gu, "");

export const isProbeObjectKey = (key: string, prefix: string): boolean => {
  const normalized = normalizePrefix(prefix);
  const start = `${normalized ? `${normalized}/` : ""}.s3-vault-sync-probe-`;
  return key.startsWith(start) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(key.slice(start.length));
};

export const probeObjectStore = async (
  objects: ObjectStore,
  prefix: string,
  beforeProbe?: (key: string) => Promise<void>,
): Promise<void> => {
  const normalized = normalizePrefix(prefix);
  const key = `${normalized ? `${normalized}/` : ""}.s3-vault-sync-probe-${crypto.randomUUID()}`;
  const firstBody = new TextEncoder().encode("probe-1");
  const secondBody = new TextEncoder().encode("probe-2");
  await beforeProbe?.(key);
  try {
    const created = await objects.put(key, firstBody, { ifNoneMatch: true });
    const read = await objects.get(key);
    if (!read || new TextDecoder().decode(read.body) !== "probe-1") {
      throw new Error("AWS S3 检测无法读回测试对象");
    }
    const listed = await objects.list(`${normalized ? `${normalized}/` : ""}.s3-vault-sync-probe-`);
    if (!listed.includes(key)) {
      throw new Error("AWS S3 检测对象在 ListObjectsV2 中不可见");
    }
    await objects.put(key, secondBody, { ifMatch: created.etag });
    let rejectedStaleWrite = false;
    try {
      await objects.put(key, firstBody, { ifMatch: created.etag });
    } catch (error) {
      if (error instanceof ObjectPreconditionError) {
        rejectedStaleWrite = true;
      } else {
        throw error;
      }
    }
    if (!rejectedStaleWrite) {
      throw new Error("AWS S3 没有拒绝过期的 If-Match 写入");
    }
  } finally {
    await objects.delete(key);
  }
};
