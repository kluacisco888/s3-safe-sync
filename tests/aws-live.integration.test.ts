import { afterAll, describe, expect, it } from "vitest";

import {
  AwsS3ObjectStore,
  type HttpExecutor,
} from "../src/storage/aws-s3-object-store";
import { probeObjectStore } from "../src/storage/object-store-probe";
import { HeadChangedError, RemoteStore } from "../src/storage/remote-store";

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
    execute: executeWithFetch,
    region,
    secretAccessKey,
    sessionToken,
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
  });
});
