import { describe, expect, it } from "vitest";

import {
  recoverPendingVaultWrites,
  safeReplaceVaultFile,
  type SafeWriteAdapter,
} from "../src/plugin/safe-vault-write";

const STAGING = ".obsidian/plugins/s3-vault-sync/staging";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const hash = async (body: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", body.slice().buffer);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
};

class MemorySafeWriteAdapter implements SafeWriteAdapter {
  readonly directories = new Set<string>([STAGING]);
  readonly files = new Map<string, Uint8Array>();
  failPromotion = false;
  beforeRename: ((fromPath: string, toPath: string) => void) | undefined;
  onWriteBinary: ((path: string) => Promise<void> | void) | undefined;

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.directories.has(path));
  }

  list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({
      files: [...this.files.keys()].filter((candidate) =>
        candidate.startsWith(`${path}/`),
      ),
      folders: [],
    });
  }

  mkdir(path: string): Promise<void> {
    this.directories.add(path);
    return Promise.resolve();
  }

  read(path: string): Promise<string> {
    const body = this.files.get(path);
    if (!body) {
      throw new Error(`Missing ${path}`);
    }
    return Promise.resolve(new TextDecoder().decode(body));
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    const body = this.files.get(path);
    if (!body) {
      throw new Error(`Missing ${path}`);
    }
    return Promise.resolve(body.slice().buffer);
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  rename(fromPath: string, toPath: string): Promise<void> {
    this.beforeRename?.(fromPath, toPath);
    if (this.failPromotion && fromPath.endsWith(".new")) {
      this.failPromotion = false;
      throw new Error("Promotion interrupted");
    }
    const body = this.files.get(fromPath);
    if (!body) {
      throw new Error(`Missing ${fromPath}`);
    }
    this.files.delete(fromPath);
    this.files.set(toPath, body);
    return Promise.resolve();
  }

  stat(path: string): Promise<{ type: string } | null> {
    if (this.files.has(path)) {
      return Promise.resolve({ type: "file" });
    }
    if (this.directories.has(path)) {
      return Promise.resolve({ type: "folder" });
    }
    return Promise.resolve(null);
  }

  write(path: string, body: string): Promise<void> {
    this.files.set(path, bytes(body));
    return Promise.resolve();
  }

  async writeBinary(path: string, body: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(body.slice(0)));
    await this.onWriteBinary?.(path);
  }
}

describe("safeReplaceVaultFile", () => {
  it("promotes verified content and removes its journal and backup", async () => {
    const adapter = new MemorySafeWriteAdapter();
    adapter.files.set("notes/example.md", bytes("before"));

    await safeReplaceVaultFile(
      adapter,
      "notes/example.md",
      bytes("after"),
      await hash(bytes("before")),
      () => "write-1",
    );

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "after",
    );
    expect([...adapter.files.keys()].filter((path) => path.startsWith(STAGING))).toEqual(
      [],
    );
  });

  it("restores the original when promotion is interrupted", async () => {
    const adapter = new MemorySafeWriteAdapter();
    adapter.files.set("notes/example.md", bytes("before"));
    adapter.failPromotion = true;

    await expect(
      safeReplaceVaultFile(
        adapter,
        "notes/example.md",
        bytes("after"),
        await hash(bytes("before")),
        () => "write-1",
      ),
    ).rejects.toThrow("Promotion interrupted");

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "before",
    );
  });

  it("recovers an original backup left by a terminated process", async () => {
    const adapter = new MemorySafeWriteAdapter();
    const journalPath = `${STAGING}/write-1.json`;
    const backupPath = `${STAGING}/write-1.backup`;
    const temporaryPath = `${STAGING}/write-1.new`;
    adapter.files.set(backupPath, bytes("before"));
    adapter.files.set(temporaryPath, bytes("after"));
    adapter.files.set(
      journalPath,
      bytes(
        JSON.stringify({
          backupPath,
          expectedHash: await hash(bytes("after")),
          hadOriginal: true,
          journalPath,
          targetPath: "notes/example.md",
          temporaryPath,
        }),
      ),
    );

    await recoverPendingVaultWrites(adapter);

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "before",
    );
    expect(adapter.files.has(journalPath)).toBe(false);
  });

  it("keeps a verified promoted target when a backup remains", async () => {
    const adapter = new MemorySafeWriteAdapter();
    const journalPath = `${STAGING}/write-1.json`;
    const backupPath = `${STAGING}/write-1.backup`;
    const temporaryPath = `${STAGING}/write-1.new`;
    adapter.files.set("notes/example.md", bytes("after"));
    adapter.files.set(backupPath, bytes("before"));
    adapter.files.set(
      journalPath,
      bytes(
        JSON.stringify({
          backupPath,
          expectedHash: await hash(bytes("after")),
          hadOriginal: true,
          journalPath,
          targetPath: "notes/example.md",
          temporaryPath,
        }),
      ),
    );

    await recoverPendingVaultWrites(adapter);

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "after",
    );
    expect(adapter.files.has(backupPath)).toBe(false);
  });

  it("refuses to replace content that changed after planning", async () => {
    const adapter = new MemorySafeWriteAdapter();
    adapter.files.set("notes/example.md", bytes("new local edit"));

    await expect(
      safeReplaceVaultFile(
        adapter,
        "notes/example.md",
        bytes("remote"),
        await hash(bytes("old local content")),
        () => "write-1",
      ),
    ).rejects.toThrow("Local file changed during synchronization");

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "new local edit",
    );
  });

  it("preserves an edit made while replacement content is staging", async () => {
    const adapter = new MemorySafeWriteAdapter();
    adapter.files.set("notes/example.md", bytes("before"));
    adapter.onWriteBinary = (path) => {
      if (path.endsWith(".new")) {
        adapter.files.set("notes/example.md", bytes("new local edit"));
      }
    };

    await expect(
      safeReplaceVaultFile(
        adapter,
        "notes/example.md",
        bytes("remote"),
        await hash(bytes("before")),
        () => "write-1",
      ),
    ).rejects.toThrow("Local file changed during synchronization");

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "new local edit",
    );
  });

  it("restores content that changes while the original is moving to backup", async () => {
    const adapter = new MemorySafeWriteAdapter();
    adapter.files.set("notes/example.md", bytes("before"));
    adapter.beforeRename = (fromPath, toPath) => {
      if (
        fromPath === "notes/example.md" &&
        toPath.endsWith("write-1.backup")
      ) {
        adapter.files.set(fromPath, bytes("new local edit"));
      }
    };

    await expect(
      safeReplaceVaultFile(
        adapter,
        "notes/example.md",
        bytes("remote"),
        await hash(bytes("before")),
        () => "write-1",
      ),
    ).rejects.toThrow("Local file changed during synchronization");

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "new local edit",
    );
    expect([...adapter.files.keys()].filter((path) => path.startsWith(STAGING))).toEqual(
      [],
    );
  });

  it("preserves a user-edited target and its original backup during recovery", async () => {
    const adapter = new MemorySafeWriteAdapter();
    const journalPath = `${STAGING}/write-1.json`;
    const backupPath = `${STAGING}/write-1.backup`;
    const temporaryPath = `${STAGING}/write-1.new`;
    adapter.files.set("notes/example.md", bytes("new local edit"));
    adapter.files.set(backupPath, bytes("before"));
    adapter.files.set(temporaryPath, bytes("remote"));
    adapter.files.set(
      journalPath,
      bytes(
        JSON.stringify({
          backupPath,
          expectedHash: await hash(bytes("remote")),
          hadOriginal: true,
          journalPath,
          targetPath: "notes/example.md",
          temporaryPath,
        }),
      ),
    );

    await expect(recoverPendingVaultWrites(adapter)).rejects.toThrow(
      "Staged write needs review",
    );

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "new local edit",
    );
    expect(new TextDecoder().decode(adapter.files.get(backupPath))).toBe("before");
    expect(adapter.files.has(temporaryPath)).toBe(true);
    expect(adapter.files.has(journalPath)).toBe(true);
  });

  it("preserves a user-created target after an interrupted create", async () => {
    const adapter = new MemorySafeWriteAdapter();
    const journalPath = `${STAGING}/write-1.json`;
    const backupPath = `${STAGING}/write-1.backup`;
    const temporaryPath = `${STAGING}/write-1.new`;
    adapter.files.set("notes/example.md", bytes("new local file"));
    adapter.files.set(temporaryPath, bytes("remote"));
    adapter.files.set(
      journalPath,
      bytes(
        JSON.stringify({
          backupPath,
          expectedHash: await hash(bytes("remote")),
          hadOriginal: false,
          journalPath,
          targetPath: "notes/example.md",
          temporaryPath,
        }),
      ),
    );

    await expect(recoverPendingVaultWrites(adapter)).rejects.toThrow(
      "Staged write needs review",
    );

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "new local file",
    );
    expect(adapter.files.has(temporaryPath)).toBe(true);
    expect(adapter.files.has(journalPath)).toBe(true);
  });

  it("cleans a journal when the original target was never replaced", async () => {
    const adapter = new MemorySafeWriteAdapter();
    const journalPath = `${STAGING}/write-1.json`;
    const backupPath = `${STAGING}/write-1.backup`;
    const temporaryPath = `${STAGING}/write-1.new`;
    const originalHash = await hash(bytes("before"));
    adapter.files.set("notes/example.md", bytes("before"));
    adapter.files.set(temporaryPath, bytes("remote"));
    adapter.files.set(
      journalPath,
      bytes(
        JSON.stringify({
          backupPath,
          expectedHash: await hash(bytes("remote")),
          hadOriginal: true,
          journalPath,
          originalHash,
          targetPath: "notes/example.md",
          temporaryPath,
        }),
      ),
    );

    await recoverPendingVaultWrites(adapter);

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "before",
    );
    expect(adapter.files.has(temporaryPath)).toBe(false);
    expect(adapter.files.has(journalPath)).toBe(false);
  });

  it("serializes concurrent replacements so recovery cannot consume an active journal", async () => {
    const adapter = new MemorySafeWriteAdapter();
    adapter.files.set("notes/example.md", bytes("before"));
    let releaseFirst = (): void => undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStaged = (): void => undefined;
    const firstIsStaged = new Promise<void>((resolve) => {
      firstStaged = resolve;
    });
    adapter.onWriteBinary = async (path) => {
      if (path.endsWith("write-1.new")) {
        firstStaged();
        await firstCanFinish;
      }
    };

    const first = safeReplaceVaultFile(
      adapter,
      "notes/example.md",
      bytes("first"),
      await hash(bytes("before")),
      () => "write-1",
    );
    await firstIsStaged;
    const second = safeReplaceVaultFile(
      adapter,
      "notes/example.md",
      bytes("second"),
      undefined,
      () => "write-2",
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.files.has(`${STAGING}/write-1.json`)).toBe(true);
    expect(adapter.files.has(`${STAGING}/write-2.json`)).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);

    expect(new TextDecoder().decode(adapter.files.get("notes/example.md"))).toBe(
      "second",
    );
    expect([...adapter.files.keys()].filter((path) => path.endsWith(".json"))).toEqual(
      [],
    );
  });
});
