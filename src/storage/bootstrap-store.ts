import type { KeyEnvelope } from "../crypto/vault-crypto";
import type { ObjectStore } from "./object-store";

export interface BootstrapRecord {
  envelope: KeyEnvelope;
  protocolVersion: 1;
  vaultId: string;
}

const normalizePrefix = (prefix: string): string =>
  prefix.replace(/^\/+|\/+$/gu, "");

const assertEnvelope = (value: unknown): KeyEnvelope => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Key Envelope is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.cipher !== "AES-256-GCM" ||
    record.kdf !== "PBKDF2-SHA256" ||
    typeof record.iterations !== "number" ||
    typeof record.ciphertext !== "string" ||
    typeof record.iv !== "string" ||
    typeof record.salt !== "string"
  ) {
    throw new Error("Key Envelope is invalid");
  }
  return {
    cipher: "AES-256-GCM",
    ciphertext: record.ciphertext,
    iterations: record.iterations,
    iv: record.iv,
    kdf: "PBKDF2-SHA256",
    salt: record.salt,
    version: 1,
  };
};

const assertBootstrapRecord = (value: unknown): BootstrapRecord => {
  if (typeof value !== "object" || value === null) {
    throw new Error("Bootstrap record is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.protocolVersion !== 1 ||
    typeof record.vaultId !== "string" ||
    !("envelope" in record)
  ) {
    throw new Error("Bootstrap record is invalid");
  }
  return {
    envelope: assertEnvelope(record.envelope),
    protocolVersion: 1,
    vaultId: record.vaultId,
  };
};

export class BootstrapStore {
  private readonly key: string;

  constructor(
    private readonly objects: ObjectStore,
    prefix: string,
  ) {
    const normalized = normalizePrefix(prefix);
    this.key = normalized ? `${normalized}/v1/key-envelope` : "v1/key-envelope";
  }

  async initialize(record: BootstrapRecord): Promise<void> {
    await this.objects.put(
      this.key,
      new TextEncoder().encode(JSON.stringify(record)),
      { ifNoneMatch: true },
    );
  }

  async read(): Promise<BootstrapRecord | undefined> {
    const stored = await this.objects.get(this.key);
    if (!stored) {
      return undefined;
    }
    const parsed = JSON.parse(new TextDecoder().decode(stored.body)) as unknown;
    return assertBootstrapRecord(parsed);
  }
}
