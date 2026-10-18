import { canonicalVaultPath } from "./canonical-path";
import { sha256Content as sha256 } from "./content-hash";
import { LocalStateChangedError } from "./errors";
import type { PersistedPathRename } from "./path-rename-tracker";
import type { SyncServiceOptions } from "./sync-service";
import type { LiveEntry } from "./sync-engine";
import type { CollisionRenameJournal, PendingCollisionRename } from "./collision-rename-journal";

export interface CollisionFile {
  path: string;
  entryId?: string;
  size: number;
  contentHash?: string;
  preview?: string;
  blockedReason?: string;
  suggestedName: string;
  previousPath?: string;
  preserveAsNew?: boolean;
}

export interface PathCollisionReview {
  paths: string[];
  reviewToken: string;
  localFiles: CollisionFile[];
  remoteFiles: CollisionFile[];
  relatedPaths: string[];
  pendingMoves: Array<{from: string; to: string}>;
  interruptedRename?: PendingCollisionRename;
}

export interface PathCollisionResolution {
  paths: string[];
  reviewToken: string;
  side: "local" | "remote";
  path: string;
  entryId?: string;
  newName: string;
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const validName = (name: string): boolean => !!name && name === name.trim() &&
  !/[\\/:*?"<>|]/.test(name) && ![...name].some(character => character.charCodeAt(0) < 32) && !/^[._]|[. ]$/.test(name) &&
  !/^~\$.*\.(?:docx?|pptx?|xlsx?)$/i.test(name) &&
  !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) &&
  new TextEncoder().encode(name).byteLength <= 255;

const suggestName = (path: string): string => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const suffix = ` (path conflict ${crypto.randomUUID()})${extension.length <= 16 ? extension : ""}`;
  let remaining = 255 - new TextEncoder().encode(suffix).byteLength;
  let stem = "";
  for (const character of dot > 0 ? name.slice(0, dot) : name) {
    remaining -= new TextEncoder().encode(character).byteLength;
    if (remaining < 0) break;
    stem += character;
  }
  return `${stem || "file"}${suffix}`;
};

const previewText = (body: Uint8Array): string | undefined => {
  if (body.byteLength > 256 * 1024) return undefined;
  try {
    const text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(body);
    return [...text].some(character => character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0))) ? undefined : text;
  } catch { return undefined; }
};

export class PathCollisionReviewer {
  constructor(private readonly options: SyncServiceOptions) {}

  private blocked(path: string, size: number): string | undefined {
    const configured = this.options.maxAutomaticFileBytes;
    const limit = typeof configured === "function" ? configured(path) : configured;
    if (limit !== undefined && size > limit) return "这个文件超过了本设备的限制。请在桌面端处理它的路径。";
    return undefined;
  }

  private async load(paths: string[], renames: ReadonlyMap<string, PersistedPathRename>) {
    const head = await this.options.remote.readHead();
    if (!head) throw new Error("远端存储尚未初始化");
    const snapshot = await this.options.remote.readSnapshot(head.value);
    const cache = await this.options.cache.load();
    const local = await this.options.local.list();
    const canonical = new Set(paths.map(canonicalVaultPath));
    const entries = Object.values(snapshot.entries).filter((entry): entry is LiveEntry =>
      entry.kind === "live" && canonical.has(canonicalVaultPath(entry.path)));
    const relevantIds = new Set(entries.map(entry => entry.entryId));
    for (const file of local) if (canonical.has(canonicalVaultPath(file.path)) && cache?.files[file.path]) {
      relevantIds.add(cache.files[file.path]!.entryId);
    }
    const related = new Set(Object.values(cache?.files ?? {}).filter(file => relevantIds.has(file.entryId)).map(file => file.path));
    const pendingMoves = [...renames].filter(([from, rename]) => relevantIds.has(rename.entryId) || canonical.has(canonicalVaultPath(from)))
      .map(([from, rename]) => {related.add(rename.toPath); return {from, to: rename.toPath};});
    const observations: Array<{path: string; hash?: string; size: number; modifiedAt: number}> = [];
    const localFiles: CollisionFile[] = [];
    for (const file of local) {
      const colliding = canonical.has(canonicalVaultPath(file.path));
      if (!colliding && !related.has(file.path)) continue;
      const blockedReason = this.blocked(file.path, file.size);
      let contentHash: string | undefined;
      let preview: string | undefined;
      if (!blockedReason) {
        if (file.size <= 256 * 1024 || !this.options.local.hashContent) {
          const body = await this.options.local.read(file.path);
          if (body.byteLength !== file.size) throw new LocalStateChangedError(file.path);
          contentHash = await sha256(body);
          preview = previewText(body);
        } else {
          const hash = await this.options.local.hashContent(file.path, {yieldToHost: this.options.yieldDuringHashing});
          if (hash.size !== file.size) throw new LocalStateChangedError(file.path);
          contentHash = hash.contentHash;
        }
      }
      observations.push({path: file.path, hash: contentHash, size: file.size, modifiedAt: file.modifiedAt});
      if (!colliding) continue;
      const movedHere = [...renames.values()].filter(rename => rename.toPath === file.path);
      const entryId = movedHere.length === 1 ? movedHere[0]!.entryId
        : renames.has(file.path) ? undefined : cache?.files[file.path]?.entryId;
      const remoteOwner = entryId ? snapshot.entries[entryId] : undefined;
      const followRemote = remoteOwner?.kind === "live" && remoteOwner.path !== file.path &&
        parentOf(remoteOwner.path) === parentOf(file.path) && !local.some(other => canonicalVaultPath(other.path) === canonicalVaultPath(remoteOwner.path));
      localFiles.push({path: file.path, entryId, size: file.size, contentHash, preview, blockedReason,
        preserveAsNew: remoteOwner?.kind === "deleted",
        suggestedName: followRemote ? basename(remoteOwner.path) : suggestName(file.path)});
    }
    const remoteFiles: CollisionFile[] = [];
    for (const entry of entries) {
      const blockedReason = this.blocked(entry.path, entry.revision.size);
      let preview: string | undefined;
      if (!blockedReason && entry.revision.size <= 256 * 1024) {
        const body = await this.options.remote.readBlob(entry.revision.blobId);
        if (!body || body.byteLength !== entry.revision.size || await sha256(body) !== entry.revision.contentHash) {
          throw new Error("无法核实 S3 上撞名文件的内容。没有执行任何改名。");
        }
        preview = previewText(body);
      }
      remoteFiles.push({path: entry.path, entryId: entry.entryId, size: entry.revision.size,
        contentHash: entry.revision.contentHash, preview, blockedReason, suggestedName: suggestName(entry.path),
        previousPath: cache?.snapshot.entries[entry.entryId]?.path});
    }
    const review: PathCollisionReview = {paths: [...new Set(paths)].sort(), localFiles, remoteFiles,
      relatedPaths: [...related].filter(path => !canonical.has(canonicalVaultPath(path))).sort(), pendingMoves,
      reviewToken: await sha256(new TextEncoder().encode(JSON.stringify({
        paths: [...canonical].sort(), head: head.value.commitId, cache,
        observations: observations.sort((a, b) => a.path.localeCompare(b.path)), renames: [...renames].sort(),
      })))};
    return {review, head, snapshot, local};
  }

  async review(paths: string[], renames: ReadonlyMap<string, PersistedPathRename>): Promise<PathCollisionReview> {
    return (await this.load(paths, renames)).review;
  }

  async resolve(request: PathCollisionResolution, renames: ReadonlyMap<string, PersistedPathRename>,
    journal: Pick<CollisionRenameJournal, "prepare" | "recover">): Promise<string> {
    const {review, head, snapshot, local} = await this.load(request.paths, renames);
    if (review.reviewToken !== request.reviewToken) throw new Error("文件或同步记录有变化。请重新加载撞名审查。");
    const files = request.side === "local" ? review.localFiles : review.remoteFiles;
    const file = files.find(file => file.path === request.path && (request.side === "local" || file.entryId === request.entryId));
    if (!file) throw new Error("所选的撞名文件已不存在。请重新加载审查。");
    if (file.blockedReason) throw new Error(file.blockedReason);
    if (!validName(request.newName)) throw new Error("请填一个各平台通用的文件名，不要填文件夹路径（最多 255 个 UTF-8 字节）。");
    const newPath = parentOf(file.path) + request.newName;
    if (newPath.split("/").some(part => !part || part.startsWith(".") || part.startsWith("_") || part === "node_modules") ||
      this.options.local.supportsPath?.(newPath) === false) throw new Error("这个仓库不支持新的路径。");
    const target = canonicalVaultPath(newPath);
    if (target === canonicalVaultPath(file.path) || await this.options.local.pathExists?.(newPath) ||
      local.some(other => canonicalVaultPath(other.path) === target || canonicalVaultPath(other.path).startsWith(`${target}/`) || target.startsWith(`${canonicalVaultPath(other.path)}/`))) {
      throw new Error("本设备上这个名字已被占用。请换一个文件名。");
    }
    const allowedOwner = request.side === "local" ? file.entryId : undefined;
    if (Object.values(snapshot.entries).some(entry =>
      (canonicalVaultPath(entry.path) === target && !(entry.entryId === allowedOwner && entry.kind === "live")) ||
      (entry.kind !== "deleted" && (canonicalVaultPath(entry.path).startsWith(`${target}/`) || target.startsWith(`${canonicalVaultPath(entry.path)}/`))))) {
      throw new Error("S3 上这个名字已有记录。请换一个文件名。");
    }
    if (request.side === "local") {
      if (!file.contentHash) throw new Error("无法核实本地内容。");
      await journal.prepare(file.path, newPath, file.contentHash, file.preserveAsNew ? undefined : file.entryId);
      if (file.preserveAsNew) {
        // Do not revive or move a deleted identity. Explicitly preserve these bytes as a new Entry.
        const body = await this.options.local.read(file.path);
        if (body.byteLength !== file.size || await sha256(body) !== file.contentHash) throw new LocalStateChangedError(file.path);
        const revision = {blobId: crypto.randomUUID(), revisionId: crypto.randomUUID(), contentHash: file.contentHash,
          size: body.byteLength, createdAt: head.serverDate};
        await this.options.remote.writeBlob(revision.blobId, body);
        const verified = await this.options.remote.readBlob(revision.blobId);
        if (!verified || verified.byteLength !== revision.size || await sha256(verified) !== revision.contentHash) {
          throw new Error("无法核实保存下来的副本。本地文件没有被挪动。");
        }
        const commitId = crypto.randomUUID();
        await this.options.remote.advance({expectedHeadEtag: head.etag,
          head: {...head.value, commitId, generation: head.value.generation + 1},
          commit: {commitId, createdAt: head.serverDate, vaultId: snapshot.vaultId, protocolVersion: 1,
            parentIds: [head.value.commitId], replicaId: this.options.replicaId,
            changes: [{kind: "set-entry", entry: {kind: "live", entryId: crypto.randomUUID(), path: newPath, revision}}]}});
      }
      await this.options.local.move(file.path, newPath, file.contentHash, null);
      if (await journal.recover() !== "ready") throw new Error("中断的改名需要先审查，同步才能继续。");
    } else {
      const entry = file.entryId ? snapshot.entries[file.entryId] : undefined;
      if (entry?.kind !== "live") throw new Error("所选的 S3 版本已不是当前版本。");
      const body = await this.options.remote.readBlob(entry.revision.blobId);
      if (!body || body.byteLength !== entry.revision.size || await sha256(body) !== entry.revision.contentHash) {
        throw new Error("S3 内容校验失败。没有执行任何改名。");
      }
      const commitId = crypto.randomUUID();
      await this.options.remote.advance({expectedHeadEtag: head.etag,
        head: {...head.value, commitId, generation: head.value.generation + 1},
        commit: {commitId, createdAt: head.serverDate, vaultId: snapshot.vaultId, protocolVersion: 1,
          parentIds: [head.value.commitId], replicaId: this.options.replicaId,
          changes: [{kind: "set-entry", entry: {...entry, path: newPath}}]}});
    }
    // Never accept other file identities or infer a content winner here; normal sync reconciles the move.
    return newPath;
  }
}
