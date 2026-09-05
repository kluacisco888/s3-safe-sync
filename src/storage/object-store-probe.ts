import { ObjectPreconditionError, type ObjectStore } from "./object-store";

const normalizePrefix = (prefix: string): string =>
  prefix.replace(/^\/+|\/+$/gu, "");

export const probeObjectStore = async (
  objects: ObjectStore,
  prefix: string,
): Promise<void> => {
  const normalized = normalizePrefix(prefix);
  const key = `${normalized}/.s3-vault-sync-probe-${crypto.randomUUID()}`;
  const firstBody = new TextEncoder().encode("probe-1");
  const secondBody = new TextEncoder().encode("probe-2");
  try {
    const created = await objects.put(key, firstBody, { ifNoneMatch: true });
    const read = await objects.get(key);
    if (!read || new TextDecoder().decode(read.body) !== "probe-1") {
      throw new Error("AWS S3 probe could not read back its test object");
    }
    const listed = await objects.list(`${normalized}/.s3-vault-sync-probe-`);
    if (!listed.includes(key)) {
      throw new Error("AWS S3 probe object was not visible to ListObjectsV2");
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
      throw new Error("AWS S3 did not reject a stale If-Match write");
    }
  } finally {
    await objects.delete(key);
  }
};
