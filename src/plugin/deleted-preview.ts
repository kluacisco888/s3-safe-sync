export const MAX_DELETED_PREVIEW_BYTES = 1024 * 1024;

const hasBinaryControlCharacter = (text: string): boolean => {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      return true;
    }
  }
  return false;
};

export const decodeDeletedPreview = (body: Uint8Array): string | undefined => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return hasBinaryControlCharacter(text) ? undefined : text;
  } catch {
    return undefined;
  }
};
