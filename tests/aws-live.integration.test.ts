import { afterAll, describe, expect, it } from "vitest";

import {
  AwsS3ObjectStore,
  type HttpExecutor,
} from "../src/storage/aws-s3-object-store";
import { probeObjectStore } from "../src/storage/object-store-probe";
import { HeadChangedError, RemoteStore } from "../src/storage/remote-store";
import { SyncService, type CachedSyncState, type LocalVaultPort } from "../src/sync/sync-service";

const accessKeyId = process.env.S3_VAULT_SYNC_TEST_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_VAULT_SYNC_TEST_SECRET_ACCESS_KEY;
const sessionToken = process.env.S3_VAULT_SYNC_TEST_SESSION_TOKEN;
const region = process.env.S3_VAULT_SYNC_TEST_REGION;
const bucket = process.env.S3_VAULT_SYNC_TEST_BUCKET;
const configured = Boolean(accessKeyId && secretAccessKey && region && bucket);
const liveDescribe = configured ? describe : describe.skip;

const executeWithFetch: HttpExecutor = async (request) => {
  const response = await fetch(request.url, {
    body: request.body?.slice().buffer,
    headers: request.headers,
    method: request.method,
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    headers,
    status: response.status,
  };
};

liveDescribe("AwsS3ObjectStore live integration", () => {
  if (!accessKeyId || !secretAccessKey || !region || !bucket) {
    return;
  }
  const testPrefix = `integration/${crypto.randomUUID()}`;
  const objects = new AwsS3ObjectStore({
    accessKeyId,
    bucket,
    downloadChunkBytes: 8,
    execute: executeWithFetch,
    region,
    secretAccessKey,
    sessionToken,
  });
  const multipartObjects = new AwsS3ObjectStore({
    accessKeyId,
    bucket,
    downloadChunkBytes: 1024 * 1024,
    execute: executeWithFetch,
    region,
    secretAccessKey,
    sessionToken,
    uploadChunkBytes: 5 * 1024 * 1024,
  });

  afterAll(async () => {
    for (const key of await objects.list(`${testPrefix}/`)) {
      await objects.delete(key);
    }
  });

  it("supports encrypted data and conditional Head publication", async () => {
    await probeObjectStore(objects, testPrefix);
    const vaultKey = crypto.getRandomValues(new Uint8Array(32));
    const first = await RemoteStore.open({ objects, prefix: testPrefix, vaultKey });
    const second = await RemoteStore.open({ objects, prefix: testPrefix, vaultKey });
    const initialCommit = {
      changes: [],
      commitId: "commit-1",
      createdAt: "2026-09-05T00:00:00.000Z",
      parentIds: [],
      protocolVersion: 1 as const,
      replicaId: "integration-a",
      vaultId: "vault-live-test",
    };
    await first.writeBlob("blob-1", new TextEncoder().encode("encrypted live test"));
    await first.initialize({
      commit: initialCommit,
      head: {
        commitId: "commit-1",
        generation: 1,
        protocolVersion: 1,
        vaultId: "vault-live-test",
      },
    });
    await expect(first.readBlob("blob-1")).resolves.toEqual(
      new TextEncoder().encode("encrypted live test"),
    );
    const firstHead = await first.readHead();
    const secondHead = await second.readHead();
    if (!firstHead || !secondHead) {
      throw new Error("Expected initialized live Head");
    }
    await first.advance({
      commit: { ...initialCommit, commitId: "commit-a", parentIds: ["commit-1"] },
      expectedHeadEtag: firstHead.etag,
      head: {
        commitId: "commit-a",
        generation: 2,
        protocolVersion: 1,
        vaultId: "vault-live-test",
      },
    });
    await expect(
      second.advance({
        commit: {
          ...initialCommit,
          commitId: "commit-b",
          parentIds: ["commit-1"],
          replicaId: "integration-b",
        },
        expectedHeadEtag: secondHead.etag,
        head: {
          commitId: "commit-b",
          generation: 2,
          protocolVersion: 1,
          vaultId: "vault-live-test",
        },
      }),
    ).rejects.toBeInstanceOf(HeadChangedError);
    await expect(first.readHead()).resolves.toMatchObject({
      value: { commitId: "commit-a", generation: 2 },
    });
  }, 20_000);

  it("round-trips a multipart object through ranged downloads", async () => {
    const body = new Uint8Array(5 * 1024 * 1024 + 17);
    body[0] = 1;
    body[body.byteLength - 1] = 255;
    const key = `${testPrefix}/multipart.bin`;

    await multipartObjects.put(key, body, { ifNoneMatch: true });
    const downloaded = await multipartObjects.get(key);

    expect(downloaded?.body.byteLength).toBe(body.byteLength);
    expect(downloaded?.body[0]).toBe(1);
    expect(downloaded?.body.at(-1)).toBe(255);
  }, 20_000);

  it("preserves both versions after a first-connect content mismatch", async () => {
    const remote = await RemoteStore.open({objects: multipartObjects,
      prefix: `${testPrefix}/content-review`, vaultKey: crypto.getRandomValues(new Uint8Array(32))});
    const makeDevice = (initial: string) => {
      let clock = 1;
      const files = new Map([["article.md", {body: new TextEncoder().encode(initial), modifiedAt: clock}]]);
      let state: CachedSyncState | undefined;
      const local: LocalVaultPort = {
        list: async () => [...files].map(([path, file]) => ({path, size: file.body.byteLength, modifiedAt: file.modifiedAt})),
        stat: async path => { const file = files.get(path); return file ? {path, size: file.body.byteLength, modifiedAt: file.modifiedAt} : undefined; },
        read: async path => { const file = files.get(path); if (!file) throw new Error("Missing test file"); return file.body.slice(); },
        write: async (path, body, expected) => {
          if (expected === null && files.has(path)) throw new Error("Test copy path occupied");
          files.set(path, {body: body.slice(), modifiedAt: ++clock});
        },
        delete: async path => { files.delete(path); },
        move: async () => { throw new Error("No move expected in this test"); },
      };
      const cache = {load: async () => state, save: async (next: CachedSyncState) => {state = next;}};
      return {local, service: new SyncService({local, cache, remote, replicaId: initial})};
    };
    const first = makeDevice("remote test version");
    await first.service.initializeNew("review-test-vault");
    const second = makeDevice("local unsynced test version");
    expect((await second.service.synchronize()).localIssues).toContainEqual({kind: "bootstrap-mismatch", path: "article.md"});
    const review = await second.service.reviewLocalContent("article.md");
    const copyPath = await second.service.preserveLocalCopyAndAcceptRemote("article.md", review.reviewToken);
    expect(new TextDecoder().decode(await second.local.read("article.md"))).toBe("remote test version");
    expect(new TextDecoder().decode(await second.local.read(copyPath!))).toBe("local unsynced test version");
    const snapshot = await remote.readSnapshot((await remote.readHead())!.value);
    const copy = Object.values(snapshot.entries).find(entry => entry.path === copyPath);
    if (copy?.kind !== "live") throw new Error("Verified local copy missing remotely");
    expect(new TextDecoder().decode(await remote.readBlob(copy.revision.blobId))).toBe("local unsynced test version");
    expect((await second.service.synchronize()).status).toBe("complete");
  }, 60_000);
});
