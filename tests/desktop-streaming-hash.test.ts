import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  desktopHashBufferBytes,
  hashDesktopFile,
  type DesktopHashDependencies,
} from "../src/plugin/desktop-streaming-hash";
import { LocalStateChangedError } from "../src/sync/errors";

const temporaryDirectories: string[] = [];
const dependencies: DesktopHashDependencies = { createHash, open, stat };

const temporaryFile = async (body: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "s3-vault-sync-hash-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "example.bin");
  await writeFile(path, body);
  return path;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("hashDesktopFile", () => {
  it("hashes across bounded chunks while reporting progress", async () => {
    const path = await temporaryFile("abcdefghijk");
    const progress: number[] = [];
    let yields = 0;

    const result = await hashDesktopFile(path, dependencies, {
      chunkBytes: 4,
      onProgress: (bytes) => progress.push(bytes),
      yieldToHost: () => {
        yields += 1;
        return Promise.resolve();
      },
    });

    expect(result).toEqual({
      contentHash:
        "sha256:ca2f2069ea0c6e4658222e06f8dd639659cbb5e67cbbba6734bc334a3799bc68",
      size: 11,
    });
    expect(progress).toEqual([4, 8, 11]);
    expect(yields).toBe(3);
  });

  it("hashes an empty file", async () => {
    const path = await temporaryFile("");

    await expect(
      hashDesktopFile(path, dependencies, { chunkBytes: 4 }),
    ).resolves.toEqual({
      contentHash:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      size: 0,
    });
  });

  it("stops when a file changes between chunks", async () => {
    const path = await temporaryFile("abcdefghijk");
    let firstChunk = true;

    await expect(
      hashDesktopFile(path, dependencies, {
        chunkBytes: 4,
        yieldToHost: async () => {
          if (firstChunk) {
            firstChunk = false;
            await truncate(path, 2);
          }
        },
      }),
    ).rejects.toMatchObject({ path } satisfies Partial<LocalStateChangedError>);
  });

  it("does not chase content appended while hashing", async () => {
    const path = await temporaryFile("abcdefgh");
    const progress: number[] = [];
    let firstChunk = true;

    await expect(
      hashDesktopFile(path, dependencies, {
        chunkBytes: 4,
        onProgress: (bytes) => progress.push(bytes),
        yieldToHost: async () => {
          if (firstChunk) {
            firstChunk = false;
            await appendFile(path, "ijkl");
          }
        },
      }),
    ).rejects.toMatchObject({ path } satisfies Partial<LocalStateChangedError>);
    expect(progress).toEqual([4, 8]);
  });

  it("rejects a same-size rewrite while hashing", async () => {
    const path = await temporaryFile("abcdefgh");
    let firstChunk = true;

    await expect(
      hashDesktopFile(path, dependencies, {
        chunkBytes: 4,
        yieldToHost: async () => {
          if (firstChunk) {
            firstChunk = false;
            await writeFile(path, "abcdWXYZ");
          }
        },
      }),
    ).rejects.toMatchObject({ path } satisfies Partial<LocalStateChangedError>);
  });

  it("rejects an atomic replacement while hashing", async () => {
    const path = await temporaryFile("abcdefgh");
    const replacementPath = `${path}.replacement`;
    await writeFile(replacementPath, "ABCDEFGH");
    let firstChunk = true;

    await expect(
      hashDesktopFile(path, dependencies, {
        chunkBytes: 4,
        yieldToHost: async () => {
          if (firstChunk) {
            firstChunk = false;
            await rename(replacementPath, path);
          }
        },
      }),
    ).rejects.toMatchObject({ path } satisfies Partial<LocalStateChangedError>);
  });

  it("allocates only the bytes needed for a small file", () => {
    expect(desktopHashBufferBytes(0)).toBe(1);
    expect(desktopHashBufferBytes(12)).toBe(12);
    expect(desktopHashBufferBytes(32 * 1024 * 1024)).toBe(8 * 1024 * 1024);
  });

  it("reports a Vault-relative path when the desktop file disappears", async () => {
    const path = await temporaryFile("temporary");
    await rm(path);

    await expect(
      hashDesktopFile(path, dependencies, {
        errorPath: "notes/temporary.md",
      }),
    ).rejects.toMatchObject({ path: "notes/temporary.md" });
  });
});
