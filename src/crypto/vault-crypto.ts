const DEFAULT_PBKDF2_ITERATIONS = 310_000;
const VAULT_KEY_BYTES = 32;

export interface KeyEnvelope {
  cipher: "AES-256-GCM";
  ciphertext: string;
  iterations: number;
  iv: string;
  kdf: "PBKDF2-SHA256";
  salt: string;
  version: 1;
}

export interface WrapKeyInput {
  iterations?: number;
  iv?: Uint8Array;
  password: string;
  salt?: Uint8Array;
  vaultKey: Uint8Array;
}

export class VaultCryptoError extends Error {
  readonly code = "INVALID_PASSWORD_OR_ENVELOPE" as const;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("The password is wrong or the Key Envelope is damaged");
    this.name = "VaultCryptoError";
    this.cause = cause;
  }
}

const randomBytes = (length: number): Uint8Array => {
  const output = new Uint8Array(length);
  crypto.getRandomValues(output);
  return output;
};

const toArrayBuffer = (input: Uint8Array): ArrayBuffer =>
  input.slice().buffer;

const encodeBase64Url = (input: Uint8Array): string => {
  let binary = "";
  for (const byte of input) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const decodeBase64Url = (input: string): Uint8Array => {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(`${padded}${"=".repeat(paddingLength)}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const deriveWrappingKey = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      iterations,
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
    },
    material,
    { length: 256, name: "AES-GCM" },
    false,
    ["decrypt", "encrypt"],
  );
};

export class VaultCrypto {
  static generateVaultKey(): Uint8Array {
    return randomBytes(VAULT_KEY_BYTES);
  }

  static async wrapKey(input: WrapKeyInput): Promise<KeyEnvelope> {
    if (input.vaultKey.byteLength !== VAULT_KEY_BYTES) {
      throw new Error(`Vault Key must be ${VAULT_KEY_BYTES} bytes`);
    }
    const iterations = input.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
    const iv = input.iv ?? randomBytes(12);
    const salt = input.salt ?? randomBytes(16);
    const wrappingKey = await deriveWrappingKey(
      input.password,
      salt,
      iterations,
    );
    const ciphertext = await crypto.subtle.encrypt(
      { iv: toArrayBuffer(iv), name: "AES-GCM" },
      wrappingKey,
      toArrayBuffer(input.vaultKey),
    );

    return {
      cipher: "AES-256-GCM",
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
      iterations,
      iv: encodeBase64Url(iv),
      kdf: "PBKDF2-SHA256",
      salt: encodeBase64Url(salt),
      version: 1,
    };
  }

  static async unwrapKey(
    password: string,
    envelope: KeyEnvelope,
  ): Promise<Uint8Array> {
    try {
      const salt = decodeBase64Url(envelope.salt);
      const iv = decodeBase64Url(envelope.iv);
      const wrappingKey = await deriveWrappingKey(
        password,
        salt,
        envelope.iterations,
      );
      const plaintext = await crypto.subtle.decrypt(
        { iv: toArrayBuffer(iv), name: "AES-GCM" },
        wrappingKey,
        toArrayBuffer(decodeBase64Url(envelope.ciphertext)),
      );
      const vaultKey = new Uint8Array(plaintext);
      if (vaultKey.byteLength !== VAULT_KEY_BYTES) {
        throw new Error("Key Envelope did not contain a valid Vault Key");
      }
      return vaultKey;
    } catch (error) {
      throw new VaultCryptoError(error);
    }
  }
}
