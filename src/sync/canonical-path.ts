export const canonicalVaultPath = (path: string): string =>
  path.normalize("NFC").toLocaleLowerCase("en-US");
