import { RcloneCompat } from "../crypto/rclone-compat";
import type { LocalVaultPort } from "../sync/sync-service";
import type { ObjectStore } from "../storage/object-store";

export interface RemotelySaveMigrationOptions {
  objects: ObjectStore;
  password: string;
  prefix: string;
}

export interface MigrationDifference {
  kind: "content-mismatch" | "local-only" | "remote-only";
  path: string;
}

export interface MigrationComparison {
  differences: MigrationDifference[];
  filesCompared: number;
  status: "clean" | "review-required";
}

const normalizePrefix = (prefix: string): string =>
  prefix.replace(/^\/+|\/+$/gu, "");

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

export class RemotelySaveMigration {
  private constructor(
    private readonly objects: ObjectStore,
    private readonly prefix: string,
    private readonly cipher: RcloneCompat,
  ) {}

  static async open(
    options: RemotelySaveMigrationOptions,
  ): Promise<RemotelySaveMigration> {
    return new RemotelySaveMigration(
      options.objects,
      normalizePrefix(options.prefix),
      await RcloneCompat.fromPassword(options.password),
    );
  }

  async compare(local: LocalVaultPort): Promise<MigrationComparison> {
    const remoteFiles = new Map<string, Uint8Array>();
    const prefixWithSlash = this.prefix ? `${this.prefix}/` : "";
    for (const key of await this.objects.list(prefixWithSlash)) {
      if (key.endsWith("/")) {
        continue;
      }
      const encryptedPath = key.slice(prefixWithSlash.length);
      const path = await this.cipher.decryptPath(encryptedPath);
      if (path.startsWith("_remotely-save-metadata-on-remote.")) {
        continue;
      }
      const stored = await this.objects.get(key);
      if (!stored) {
        throw new Error(`Legacy object disappeared during migration: ${key}`);
      }
      remoteFiles.set(path, await this.cipher.decryptData(stored.body));
    }

    const localFiles = new Map<string, Uint8Array>();
    for (const file of await local.list()) {
      localFiles.set(file.path, await local.read(file.path));
    }

    const differences: MigrationDifference[] = [];
    for (const [path, remoteBody] of remoteFiles) {
      const localBody = localFiles.get(path);
      if (!localBody) {
        differences.push({ kind: "remote-only", path });
      } else if (!equalBytes(localBody, remoteBody)) {
        differences.push({ kind: "content-mismatch", path });
      }
    }
    for (const path of localFiles.keys()) {
      if (!remoteFiles.has(path)) {
        differences.push({ kind: "local-only", path });
      }
    }
    differences.sort((left, right) => left.path.localeCompare(right.path));
    return {
      differences,
      filesCompared: new Set([...remoteFiles.keys(), ...localFiles.keys()]).size,
      status: differences.length === 0 ? "clean" : "review-required",
    };
  }
}
