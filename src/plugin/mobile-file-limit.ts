const MOBILE_FILE_BYTES = 50 * 1024 * 1024;
const CELLULAR_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const NOTE_EXTENSIONS = new Set(["base", "canvas", "md"]);

const isAttachmentPath = (path: string): boolean => {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const extensionIndex = basename.lastIndexOf(".");
  if (extensionIndex < 0) {
    return true;
  }
  return !NOTE_EXTENSIONS.has(
    basename.slice(extensionIndex + 1).toLocaleLowerCase("en-US"),
  );
};

export const automaticMobileFileLimit = (
  path: string,
  isMobile: boolean,
  networkType?: string,
): number | undefined => {
  if (!isMobile) {
    return undefined;
  }
  return networkType !== "wifi" && isAttachmentPath(path)
    ? CELLULAR_ATTACHMENT_BYTES
    : MOBILE_FILE_BYTES;
};
