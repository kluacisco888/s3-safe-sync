export const toArrayBuffer = (body: Uint8Array): ArrayBuffer =>
  body.byteOffset === 0 &&
  body.buffer instanceof ArrayBuffer &&
  body.byteLength === body.buffer.byteLength
    ? body.buffer
    : body.slice().buffer;

export const sha256Content = async (
  body: ArrayBuffer | Uint8Array,
): Promise<string> => {
  const input = body instanceof Uint8Array ? toArrayBuffer(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
};
