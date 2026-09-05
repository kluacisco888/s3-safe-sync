import { describe, expect, it } from "vitest";

import {
  CredentialStore,
  type SecretStoragePort,
} from "../src/plugin/credential-store";

class MemorySecretStorage implements SecretStoragePort {
  private readonly values = new Map<string, string>();

  getSecret(id: string): string | null {
    return this.values.get(id) ?? null;
  }

  setSecret(id: string, value: string): void {
    this.values.set(id, value);
  }
}

describe("CredentialStore", () => {
  it("round-trips AWS credentials and the unlocked Vault Key through SecretStorage", () => {
    const secrets = new MemorySecretStorage();
    const store = new CredentialStore(secrets);
    const credentials = {
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret-example",
    };
    const vaultKey = Uint8Array.from({ length: 32 }, (_, index) => index);

    store.saveAwsCredentials(credentials);
    store.saveVaultKey(vaultKey);

    expect(store.loadAwsCredentials()).toEqual(credentials);
    expect(store.loadVaultKey()).toEqual(vaultKey);
  });
});
