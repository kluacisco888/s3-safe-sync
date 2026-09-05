import { describe, expect, it } from "vitest";

import { RcloneCompat } from "../src/crypto/rclone-compat";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("RcloneCompat", () => {
  it("matches the Remotely Save Rclone-base64 content format", async () => {
    const cipher = await RcloneCompat.fromPassword(
      "correct horse battery staple",
    );
    const plaintext = new TextEncoder().encode("hello\n");
    const nonce = fromHex(
      "0102030405060708090a0b0c0d0e0f101112131415161718",
    );

    const encrypted = await cipher.encryptData(plaintext, nonce);

    expect(toHex(encrypted)).toBe(
      "52434c4f4e4500000102030405060708090a0b0c0d0e0f1011121314151617188ccda06bef4e15487377e5fba51f246f0faecc47789e",
    );
    await expect(cipher.decryptData(encrypted)).resolves.toEqual(plaintext);
  });
});
