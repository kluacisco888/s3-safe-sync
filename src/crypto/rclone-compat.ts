import { Cipher } from "@fyears/rclone-crypt";

export class RcloneCompat {
  private constructor(private readonly cipher: Cipher) {}

  static async fromPassword(password: string): Promise<RcloneCompat> {
    const cipher = new Cipher("base64");
    await cipher.key(password, "");
    return new RcloneCompat(cipher);
  }

  static fromVaultKey(vaultKey: Uint8Array): Promise<RcloneCompat> {
    let binary = "";
    for (const byte of vaultKey) {
      binary += String.fromCharCode(byte);
    }
    const password = btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    return RcloneCompat.fromPassword(password);
  }

  decryptData(ciphertext: Uint8Array): Promise<Uint8Array> {
    return this.cipher.decryptData(ciphertext);
  }

  decryptPath(ciphertext: string): Promise<string> {
    return this.cipher.decryptFileName(ciphertext);
  }

  encryptData(
    plaintext: Uint8Array,
    nonce?: Uint8Array,
  ): Promise<Uint8Array> {
    return this.cipher.encryptData(plaintext, nonce);
  }

  encryptPath(plaintext: string): Promise<string> {
    return this.cipher.encryptFileName(plaintext);
  }
}
