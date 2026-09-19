import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupEmptyParents } from "../src/plugin/empty-directory-cleanup";

const temporaryDirectories: string[] = [];

const temporaryVault = async () => {
  const root = await mkdtemp(join(tmpdir(), "s3-vault-sync-empty-directories-"));
  temporaryDirectories.push(root);
  return {
    root,
    fullPath: (relative: string) => join(root, relative),
    configDir: ".obsidian",
    fs: { lstat, readdir: (path: string) => readdir(path), rmdir },
  };
};

afterEach(async () => {
  for (const root of temporaryDirectories.splice(0)) {
    const directories = [root];
    for (const directory of directories) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(path);
        } else {
          await unlink(path);
        }
      }
    }
    for (const directory of directories.reverse()) {
      await rmdir(directory);
    }
  }
});

describe("cleanupEmptyParents", () => {
  it("removes only retired files' empty ancestors, from deepest to shallowest", async () => {
    const vault = await temporaryVault();
    await mkdir(vault.fullPath("old/nested"), { recursive: true });
    await mkdir(vault.fullPath("unrelated"));

    await expect(cleanupEmptyParents(["old/nested/note.md"], vault)).resolves.toEqual([
      "old/nested",
      "old",
    ]);
    expect(await readdir(vault.root)).toEqual(["unrelated"]);
  });

  it("preserves configuration, excluded, and ignored subtrees", async () => {
    const vault = await temporaryVault();
    const protectedDirectories = ["settings", ".hidden", "_private", ".git", "node_modules", "ignored"];
    for (const relative of protectedDirectories) {
      await mkdir(vault.fullPath(`${relative}/nested`), { recursive: true });
    }

    await expect(cleanupEmptyParents(
      protectedDirectories.map((relative) => `${relative}/nested/note.md`),
      { ...vault, configDir: "settings", isInSyncScope: (path: string) => !path.startsWith("ignored") },
    )).resolves.toEqual([]);
    expect((await readdir(vault.root)).sort()).toEqual([...protectedDirectories].sort());
  });

  it("preserves a file created after the emptiness check", async () => {
    const vault = await temporaryVault();
    const parent = vault.fullPath("notes");
    await mkdir(parent);

    await expect(cleanupEmptyParents(["notes/retired.md"], {
      ...vault,
      fs: { ...vault.fs, rmdir: async (path) => {
        await writeFile(join(path, "new.md"), "concurrent edit");
        await rmdir(path);
      } },
    })).resolves.toEqual([]);
    expect(await readFile(join(parent, "new.md"), "utf8")).toBe("concurrent edit");
  });

  it("does not follow a symbolic-link ancestor to an empty directory", async () => {
    const vault = await temporaryVault();
    await mkdir(vault.fullPath("target/nested"), { recursive: true });
    await symlink(vault.fullPath("target"), vault.fullPath("alias"), "dir");

    await expect(cleanupEmptyParents(["alias/nested/retired.md"], vault)).resolves.toEqual([]);
    expect(await readdir(vault.fullPath("target"))).toEqual(["nested"]);
    expect((await lstat(vault.fullPath("alias"))).isSymbolicLink()).toBe(true);
  });

  it("preserves an empty replacement directory created after enumeration", async () => {
    const vault = await temporaryVault();
    const path = vault.fullPath("notes");
    await mkdir(path);

    await expect(cleanupEmptyParents(["notes/retired.md"], {
      ...vault,
      fs: { ...vault.fs, readdir: async (directory) => {
        const entries = await readdir(directory);
        await rename(directory, vault.fullPath("saved"));
        await mkdir(directory);
        return entries;
      } },
    })).resolves.toEqual([]);
    expect((await lstat(path)).isDirectory()).toBe(true);
  });

  it("propagates cancellation after enumeration without removing the directory", async () => {
    const vault = await temporaryVault();
    const path = vault.fullPath("notes");
    await mkdir(path);
    let active = true;
    const cancelled = new Error("Sync session cancelled");

    await expect(cleanupEmptyParents(["notes/retired.md"], {
      ...vault,
      assertActive: () => { if (!active) throw cancelled; },
      fs: { ...vault.fs, readdir: async (directory) => {
        const entries = await readdir(directory);
        active = false;
        return entries;
      } },
    })).rejects.toBe(cancelled);
    expect((await lstat(path)).isDirectory()).toBe(true);
  });

  it("preserves directories when stable identity is unavailable", async () => {
    const vault = await temporaryVault();
    const path = vault.fullPath("notes");
    await mkdir(path);

    await expect(cleanupEmptyParents(["notes/retired.md"], {
      ...vault,
      fs: { ...vault.fs, lstat: async (directory) => {
        const state = await lstat(directory);
        state.ino = 0;
        return state;
      } },
    })).resolves.toEqual([]);
    expect((await lstat(path)).isDirectory()).toBe(true);
  });

  it.each(["note.md", ".hidden", "_ignored", "zero-bytes"])("preserves a directory containing %s", async (name) => {
    const vault = await temporaryVault();
    await mkdir(vault.fullPath("notes"));
    await writeFile(vault.fullPath(`notes/${name}`), "");

    await expect(cleanupEmptyParents(["notes/retired.md"], vault)).resolves.toEqual([]);
    expect(await readdir(vault.fullPath("notes"))).toEqual([name]);
  });

  it("preserves empty subdirectories unrelated to the retired file", async () => {
    const vault = await temporaryVault();
    await mkdir(vault.fullPath("notes/unrelated"), { recursive: true });

    await expect(cleanupEmptyParents(["notes/retired.md"], vault)).resolves.toEqual([]);
    expect(await readdir(vault.fullPath("notes"))).toEqual(["unrelated"]);
  });

  it("preserves a regular file substituted immediately before removal", async () => {
    const vault = await temporaryVault();
    const path = vault.fullPath("notes");
    await mkdir(path);

    await expect(cleanupEmptyParents(["notes/retired.md"], {
      ...vault,
      fs: { ...vault.fs, rmdir: async (directory) => {
        await rename(directory, vault.fullPath("saved"));
        await writeFile(directory, "new local content");
        await rmdir(directory);
      } },
    })).resolves.toEqual([]);
    expect(await readFile(path, "utf8")).toBe("new local content");
  });

  it("preserves a symbolic link substituted immediately before removal", async () => {
    const vault = await temporaryVault();
    const path = vault.fullPath("notes");
    await mkdir(path);
    await mkdir(vault.fullPath("target"));

    await expect(cleanupEmptyParents(["notes/retired.md"], {
      ...vault,
      fs: { ...vault.fs, rmdir: async (directory) => {
        await rename(directory, vault.fullPath("saved"));
        await symlink(vault.fullPath("target"), directory, "dir");
        await rmdir(directory);
      } },
    })).resolves.toEqual([]);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect((await lstat(vault.fullPath("target"))).isDirectory()).toBe(true);
  });

  it("preserves an ancestor replaced by a symbolic link after enumeration", async () => {
    const vault = await temporaryVault();
    await mkdir(vault.fullPath("notes/nested"), { recursive: true });
    await mkdir(vault.fullPath("target/nested"), { recursive: true });

    await expect(cleanupEmptyParents(["notes/nested/retired.md"], {
      ...vault,
      fs: { ...vault.fs, readdir: async (directory) => {
        const entries = await readdir(directory);
        await rename(vault.fullPath("notes"), vault.fullPath("saved"));
        await symlink(vault.fullPath("target"), vault.fullPath("notes"), "dir");
        return entries;
      } },
    })).resolves.toEqual([]);
    expect(await readdir(vault.fullPath("target"))).toEqual(["nested"]);
  });

  it("preserves a regular file presented as a retired file's parent", async () => {
    const vault = await temporaryVault();
    await writeFile(vault.fullPath("notes"), "existing local content");

    await expect(cleanupEmptyParents(["notes/retired.md"], vault)).resolves.toEqual([]);
    expect(await readFile(vault.fullPath("notes"), "utf8")).toBe("existing local content");
  });

  it("keeps the Vault root and rejects unsafe retired paths", async () => {
    const vault = await temporaryVault();

    await expect(cleanupEmptyParents([
      "retired.md", "", "/retired.md", "../retired.md", "notes/../retired.md", "notes//retired.md", "C:/retired.md", "notes\\retired.md",
    ], vault)).resolves.toEqual([]);
    expect((await lstat(vault.root)).isDirectory()).toBe(true);
  });

  it.each(["", "/"])("rejects a symbolic-link Vault root with suffix '%s'", async (suffix) => {
    const vault = await temporaryVault();
    await mkdir(vault.fullPath("target/notes"), { recursive: true });
    await symlink(vault.fullPath("target"), vault.fullPath("alias"), "dir");

    await expect(cleanupEmptyParents(["notes/retired.md"], {
      ...vault,
      fullPath: (relative) => relative
        ? join(vault.fullPath("alias"), relative)
        : `${vault.fullPath("alias")}${suffix}`,
    })).resolves.toEqual([]);
    expect(await readdir(vault.fullPath("target"))).toEqual(["notes"]);
  });

  it.each(["lstat", "readdir", "rmdir"] as const)("keeps a directory when %s fails", async (operation) => {
    const vault = await temporaryVault();
    await mkdir(vault.fullPath("notes"));

    await expect(cleanupEmptyParents(["notes/retired.md"], {
      ...vault,
      fs: { ...vault.fs, [operation]: () => Promise.reject(new Error("File system unavailable")) },
    })).resolves.toEqual([]);
    expect((await lstat(vault.fullPath("notes"))).isDirectory()).toBe(true);
  });
});
