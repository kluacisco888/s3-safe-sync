import { describe, expect, it, vi } from "vitest";

import {
  deleteVaultPath,
  type VaultDeletionPort,
} from "../src/plugin/vault-delete";

interface TestNode {
  kind: "file" | "folder";
}

class MemoryDeletionVault implements VaultDeletionPort<TestNode> {
  exists = true;
  indexed: TestNode | null = null;
  removeSucceeds = true;
  statType: "file" | "folder" | null = "file";
  trashLocalSucceeds = false;
  trashSucceeds = false;
  readonly adapter = {
    exists: vi.fn(async () => this.exists),
    remove: vi.fn(async () => {
      if (this.removeSucceeds) {
        this.exists = false;
      }
    }),
    stat: vi.fn(async () =>
      this.statType ? { type: this.statType } : null,
    ),
    trashLocal: vi.fn(async () => {
      if (this.trashLocalSucceeds) {
        this.exists = false;
        this.indexed = null;
      }
    }),
  };
  readonly delete = vi.fn(async () => {
    this.exists = false;
    this.indexed = null;
  });
  readonly trash = vi.fn(async () => {
    if (this.trashSucceeds) {
      this.exists = false;
      this.indexed = null;
    }
  });

  getAbstractFileByPath(): TestNode | null {
    return this.indexed;
  }
}

const isFile = (candidate: TestNode): boolean => candidate.kind === "file";

describe("deleteVaultPath", () => {
  it("removes an existing adapter path when the Vault index misses it", async () => {
    const vault = new MemoryDeletionVault();

    await deleteVaultPath(vault, "notes/example.md", isFile);

    expect(vault.adapter.remove).toHaveBeenCalledWith("notes/example.md");
    expect(vault.exists).toBe(false);
  });

  it("permanently deletes an indexed path when trash leaves it in place", async () => {
    const vault = new MemoryDeletionVault();
    const file = { kind: "file" as const };
    vault.indexed = file;

    await deleteVaultPath(vault, "notes/example.md", isFile);

    expect(vault.trash).toHaveBeenCalledWith(file, false);
    expect(vault.delete).toHaveBeenCalledWith(file);
    expect(vault.exists).toBe(false);
  });

  it("does not use a permanent fallback after trash succeeds", async () => {
    const vault = new MemoryDeletionVault();
    vault.indexed = { kind: "file" };
    vault.trashSucceeds = true;

    await deleteVaultPath(vault, "notes/example.md", isFile);

    expect(vault.delete).not.toHaveBeenCalled();
    expect(vault.adapter.remove).not.toHaveBeenCalled();
  });

  it("does not use a permanent fallback after local trash succeeds", async () => {
    const vault = new MemoryDeletionVault();
    vault.trashLocalSucceeds = true;

    await deleteVaultPath(vault, "notes/example.md", isFile);

    expect(vault.adapter.trashLocal).toHaveBeenCalledWith("notes/example.md");
    expect(vault.delete).not.toHaveBeenCalled();
    expect(vault.adapter.remove).not.toHaveBeenCalled();
  });

  it("refuses to delete a folder found at a file path", async () => {
    const vault = new MemoryDeletionVault();
    vault.indexed = { kind: "folder" };

    await expect(
      deleteVaultPath(vault, "notes/example.md", isFile),
    ).rejects.toThrow("Refusing to delete a folder");

    expect(vault.trash).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
    expect(vault.adapter.remove).not.toHaveBeenCalled();
  });

  it("refuses a folder that replaces the file after trash returns", async () => {
    const vault = new MemoryDeletionVault();
    const file = { kind: "file" as const };
    const folder = { kind: "folder" as const };
    vi.spyOn(vault, "getAbstractFileByPath")
      .mockReturnValueOnce(file)
      .mockReturnValueOnce(folder);

    await expect(
      deleteVaultPath(vault, "notes/example.md", isFile),
    ).rejects.toThrow("Refusing to delete a folder");

    expect(vault.delete).not.toHaveBeenCalled();
    expect(vault.adapter.remove).not.toHaveBeenCalled();
  });

  it("refuses an unindexed adapter path that is a folder", async () => {
    const vault = new MemoryDeletionVault();
    vault.statType = "folder";

    await expect(
      deleteVaultPath(vault, "notes/example.md", isFile),
    ).rejects.toThrow("Refusing to remove a non-file path");

    expect(vault.adapter.remove).not.toHaveBeenCalled();
  });

  it("fails if the adapter path still exists after removal", async () => {
    const vault = new MemoryDeletionVault();
    vault.removeSucceeds = false;

    await expect(
      deleteVaultPath(vault, "notes/example.md", isFile),
    ).rejects.toThrow("still exists after deletion");
  });
});
