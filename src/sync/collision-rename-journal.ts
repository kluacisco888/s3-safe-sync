import { sha256Content as sha256 } from "./content-hash";
import type { LocalVaultPort } from "./sync-service";

export interface PendingCollisionRename {
  from: string;
  to: string;
  expectedHash: string;
  entryId?: string;
  identitySourcePath?: string;
}

export interface CollisionRenameJournalStore {
  read(): PendingCollisionRename | undefined;
  prepare(intent: PendingCollisionRename): Promise<void>;
  finish(intent: PendingCollisionRename, moved: boolean): Promise<void>;
}

export class CollisionRenameJournal {
  constructor(private readonly local: LocalVaultPort, private readonly store: CollisionRenameJournalStore) {}

  async prepare(from: string, to: string, expectedHash: string, entryId?: string): Promise<void> {
    if (this.store.read()) throw new Error("An interrupted path rename needs review first.");
    await this.store.prepare({from, to, expectedHash, entryId});
  }

  private async hash(path: string): Promise<string | undefined> {
    if (!await this.local.stat(path)) return undefined;
    return this.local.hashContent ? (await this.local.hashContent(path)).contentHash : sha256(await this.local.read(path));
  }

  async recover(confirmation?: {side: "source" | "target"; hash: string}): Promise<"ready" | "needs-review"> {
    const intent = this.store.read();
    if (!intent) return "ready";
    const source = await this.hash(intent.from);
    const target = await this.hash(intent.to);
    let moved: boolean;
    if (confirmation) {
      if ((confirmation.side === "source" ? source : target) !== confirmation.hash) {
        throw new Error("Recovery content changed again. Reload the collision review.");
      }
      moved = confirmation.side === "target";
    } else if (source === intent.expectedHash && target === undefined) {
      moved = false;
    } else if (source === undefined && target === intent.expectedHash) {
      moved = true;
    } else {
      return "needs-review";
    }
    await this.store.finish(intent, moved);
    return "ready";
  }
}
