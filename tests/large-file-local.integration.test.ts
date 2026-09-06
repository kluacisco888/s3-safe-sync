import { describe, expect, it } from "vitest";

import { RcloneCompat } from "../src/crypto/rclone-compat";

const enabled = process.env.S3_VAULT_SYNC_LARGE_LOCAL_TEST === "1";
const largeDescribe = enabled ? describe : describe.skip;

largeDescribe("50 MB local encryption", () => {
  it("round-trips one mobile-limit Revision without truncation", async () => {
    const size = 50 * 1024 * 1024;
    const plaintext = new Uint8Array(size);
    for (let offset = 0; offset < plaintext.byteLength; offset += 4093) {
      plaintext[offset] = (offset / 4093) % 251;
    }
    plaintext[plaintext.byteLength - 1] = 255;
    const expectedHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", plaintext),
    );
    const cipher = await RcloneCompat.fromVaultKey(
      crypto.getRandomValues(new Uint8Array(32)),
    );

    const encrypted = await cipher.encryptData(plaintext);
    const decrypted = await cipher.decryptData(encrypted);
    const actualHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", decrypted.slice().buffer),
    );

    expect(decrypted.byteLength).toBe(size);
    expect(decrypted[0]).toBe(0);
    expect(decrypted.at(-1)).toBe(255);
    expect(actualHash).toEqual(expectedHash);
  }, 120_000);
});
