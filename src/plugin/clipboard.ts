export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export const copyText = async (
  text: string,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> => {
  if (!clipboard) {
    return false;
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
