import { LocalStateChangedError } from "../sync/errors";

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export interface DesktopHashOptions {
  chunkBytes?: number;
  errorPath?: string;
  onProgress?: (hashedBytes: number) => void;
  yieldToHost?: () => Promise<void>;
}

export interface DesktopHashResult {
  contentHash: string;
  size: number;
}

interface DesktopFileHandle {
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<DesktopFileState>;
}

interface DesktopFileState {
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

interface Sha256Hash {
  digest(encoding: "hex"): string;
  update(data: Uint8Array): void;
}

export interface DesktopHashDependencies {
  createHash(algorithm: "sha256"): Sha256Hash;
  open(path: string, flags: "r"): Promise<DesktopFileHandle>;
  stat(path: string): Promise<DesktopFileState>;
}

const sameFileState = (
  left: DesktopFileState,
  right: DesktopFileState,
): boolean =>
  left.ctimeMs === right.ctimeMs &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mtimeMs === right.mtimeMs &&
  left.size === right.size;

export const desktopHashBufferBytes = (
  fileSize: number,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): number => Math.min(chunkBytes, Math.max(1, fileSize));

export const hashDesktopFile = async (
  path: string,
  dependencies: DesktopHashDependencies,
  options: DesktopHashOptions = {},
): Promise<DesktopHashResult> => {
  const errorPath = options.errorPath ?? path;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("Hash chunk size must be a positive integer");
  }

  let handle;
  try {
    handle = await dependencies.open(path, "r");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new LocalStateChangedError(errorPath);
    }
    throw error;
  }

  try {
    const initial = await handle.stat();
    const hash = dependencies.createHash("sha256");
    const buffer = new Uint8Array(
      desktopHashBufferBytes(initial.size, chunkBytes),
    );
    let hashedBytes = 0;

    while (hashedBytes < initial.size) {
      const remainingBytes = initial.size - hashedBytes;
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, remainingBytes),
      );
      if (bytesRead === 0) {
        throw new LocalStateChangedError(errorPath);
      }
      hash.update(buffer.subarray(0, bytesRead));
      hashedBytes += bytesRead;
      options.onProgress?.(hashedBytes);
      await options.yieldToHost?.();
    }

    const [finalHandleState, finalPathState] = await Promise.all([
      handle.stat(),
      dependencies.stat(path).catch((error: unknown) => {
        if ((error as { code?: string }).code === "ENOENT") {
          throw new LocalStateChangedError(errorPath);
        }
        throw error;
      }),
    ]);
    if (
      hashedBytes !== initial.size ||
      !sameFileState(initial, finalHandleState) ||
      !sameFileState(initial, finalPathState)
    ) {
      throw new LocalStateChangedError(errorPath);
    }

    return {
      contentHash: `sha256:${hash.digest("hex")}`,
      size: hashedBytes,
    };
  } finally {
    await handle.close();
  }
};
