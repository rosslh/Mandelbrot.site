// Embeds view parameters into an exported PNG as tEXt chunks so a saved image
// stays exactly regenerable even after it is renamed. A PNG is a signature
// followed by a sequence of length-prefixed, CRC-checked chunks; we insert new
// tEXt chunks immediately before the terminating IEND chunk. oxipng preserves
// text chunks by default, so the metadata survives the optional optimization
// pass. No dependency is needed: the chunk framing is a few dozen lines.

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// Precomputed CRC-32 lookup table (IEEE polynomial, as used by PNG).
const crcTable: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeLatin1(text: string): Uint8Array {
  // PNG tEXt keywords and text are Latin-1 (ISO-8859-1). Callers pass ASCII
  // payloads (share URLs and JSON), so any code point above 0xff is unexpected;
  // clamp defensively rather than silently corrupt the byte stream.
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Builds a single PNG tEXt chunk: length + "tEXt" + keyword + 0x00 + text + CRC. */
function buildTextChunk(keyword: string, text: string): Uint8Array {
  const typeBytes = encodeLatin1("tEXt");
  const keywordBytes = encodeLatin1(keyword);
  const textBytes = encodeLatin1(text);

  // Chunk data is keyword, a null separator, then the text.
  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  data.set(keywordBytes, 0);
  data[keywordBytes.length] = 0;
  data.set(textBytes, keywordBytes.length + 1);

  // CRC covers the chunk type and the chunk data.
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  const crc = crc32(crcInput);

  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length); // length excludes type, data-only length
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc);
  return chunk;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) {
    return false;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return false;
    }
  }
  return true;
}

/** Returns the offset of the IEND chunk's 4-byte length field, or -1 if the
 * buffer is not a well-formed PNG. Walks the chunk list rather than scanning
 * for the "IEND" bytes so it cannot be fooled by that pattern appearing inside
 * pixel data. */
function findIendOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (type === "IEND") {
      return offset;
    }
    // Advance past length (4) + type (4) + data + CRC (4).
    offset += 12 + length;
  }
  return -1;
}

/** Returns a new PNG buffer with the given text entries embedded as tEXt
 * chunks, inserted just before IEND. If the input is not a valid PNG it is
 * returned unchanged so a failed insertion never breaks the download. */
export function embedTextChunks(
  pngBuffer: ArrayBuffer,
  entries: { keyword: string; text: string }[],
): ArrayBuffer {
  const bytes = new Uint8Array(pngBuffer);
  if (!hasPngSignature(bytes)) {
    return pngBuffer;
  }
  const iendOffset = findIendOffset(bytes);
  if (iendOffset < 0) {
    return pngBuffer;
  }

  const chunks = entries.map((entry) =>
    buildTextChunk(entry.keyword, entry.text),
  );
  const insertLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

  const result = new Uint8Array(bytes.length + insertLength);
  result.set(bytes.subarray(0, iendOffset), 0);
  let writeOffset = iendOffset;
  for (const chunk of chunks) {
    result.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  result.set(bytes.subarray(iendOffset), writeOffset);
  return result.buffer;
}
