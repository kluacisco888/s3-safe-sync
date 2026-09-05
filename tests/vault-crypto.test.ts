import { describe, expect, it } from "vitest";

import { VaultCrypto } from "../src/crypto/vault-crypto";

const bytes = (start: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => start + index);

describe("VaultCrypto", () => {
  it("wraps a Vault Key with the documented PBKDF2 and AES-GCM format", async () => {
    const envelope = await VaultCrypto.wrapKey({
      iterations: 1_000,
      iv: bytes(16, 12),
      password: "correct horse battery staple",
      salt: bytes(0, 16),
      vaultKey: bytes(0, 32),
    });

    expect(envelope).toEqual({
      cipher: "AES-256-GCM",
      ciphertext:
        "HOazIGPD-6NiYDp21pA9_KU7jwA04sTgkjDBxObq_NlUDPAZe634nDupDv7MwRT9",
      iv: "EBESExQVFhcYGRob",
      kdf: "PBKDF2-SHA256",
      iterations: 1_000,
      salt: "AAECAwQFBgcICQoLDA0ODw",
      version: 1,
    });

    await expect(
      VaultCrypto.unwrapKey("correct horse battery staple", envelope),
    ).resolves.toEqual(bytes(0, 32));
  });

  it("rejects a wrong password and a modified Key Envelope", async () => {
    const envelope = await VaultCrypto.wrapKey({
      iterations: 1_000,
      iv: bytes(16, 12),
      password: "correct password",
      salt: bytes(0, 16),
      vaultKey: bytes(0, 32),
    });

    await expect(
      VaultCrypto.unwrapKey("wrong password", envelope),
    ).rejects.toMatchObject({ code: "INVALID_PASSWORD_OR_ENVELOPE" });

    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -1)}A`,
    };
    await expect(
      VaultCrypto.unwrapKey("correct password", tampered),
    ).rejects.toMatchObject({ code: "INVALID_PASSWORD_OR_ENVELOPE" });
  });
});
