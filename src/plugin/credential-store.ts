export interface SecretStoragePort {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const ACCESS_KEY_ID = "s3-vault-sync-access-key-id";
const SECRET_ACCESS_KEY = "s3-vault-sync-secret-access-key";
const VAULT_KEY = "s3-vault-sync-vault-key";

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
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const binary = atob(`${normalized}${"=".repeat(paddingLength)}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export class CredentialStore {
  constructor(private readonly secrets: SecretStoragePort) {}

  loadAwsCredentials(): AwsCredentials | undefined {
    const accessKeyId = this.secrets.getSecret(ACCESS_KEY_ID);
    const secretAccessKey = this.secrets.getSecret(SECRET_ACCESS_KEY);
    if (!accessKeyId || !secretAccessKey) {
      return undefined;
    }
    return { accessKeyId, secretAccessKey };
  }

  loadVaultKey(): Uint8Array | undefined {
    const encoded = this.secrets.getSecret(VAULT_KEY);
    if (!encoded) {
      return undefined;
    }
    const vaultKey = decodeBase64Url(encoded);
    return vaultKey.byteLength === 32 ? vaultKey : undefined;
  }

  saveAwsCredentials(credentials: AwsCredentials): void {
    this.secrets.setSecret(ACCESS_KEY_ID, credentials.accessKeyId);
    this.secrets.setSecret(SECRET_ACCESS_KEY, credentials.secretAccessKey);
  }

  saveVaultKey(vaultKey: Uint8Array): void {
    if (vaultKey.byteLength !== 32) {
      throw new Error("Vault Key must be 32 bytes");
    }
    this.secrets.setSecret(VAULT_KEY, encodeBase64Url(vaultKey));
  }
}
