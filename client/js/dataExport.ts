// Packages the current view's per-pixel escape values as a machine-readable
// download for researchers who need the underlying numbers rather than a PNG
// (issue #47). The float buffer is the same one the tile layer caches to
// recolor without recomputing; here it is emitted before colorization.
//
// The download is a ZIP holding two entries:
//   - data.npy      the H x W float32 array (NumPy .npy v1.0)
//   - metadata.json the view parameters, so the data is self-describing
// Both formats are written by hand (fixed headers + raw little-endian bytes),
// so no dependency is added — matching pngMetadata.ts's chunk-framing approach.

// Precomputed CRC-32 lookup table (IEEE polynomial, as used by ZIP and PNG).
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

function encodeAscii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Encodes a 2D float32 array as a NumPy `.npy` v1.0 buffer. `shape` is
 * (rows, columns) = (height, width) and `data` is row-major, so
 * `np.load(...)` yields an array indexable as `[y, x]`. Interior (never
 * escaping) pixels are `Infinity`, which loads as `numpy.inf`. */
export function encodeNpyFloat32(
  data: Float32Array,
  height: number,
  width: number,
): Uint8Array {
  // The header dict must use exactly the keys NumPy expects; extra keys would
  // break np.load, which is why the view parameters live in a sidecar instead.
  const headerText = `{'descr': '<f4', 'fortran_order': False, 'shape': (${height}, ${width}), }`;

  // magic (6) + version (2) + header-length (2) + header must be a multiple of
  // 64 bytes; the header is space-padded and terminated with a newline.
  const preludeLength = 10;
  const unpaddedLength = preludeLength + headerText.length + 1; // +1 for '\n'
  const paddedLength = Math.ceil(unpaddedLength / 64) * 64;
  const padding = paddedLength - unpaddedLength;
  const fullHeader = headerText + " ".repeat(padding) + "\n";
  const headerBytes = encodeAscii(fullHeader);

  const dataBytes = new Uint8Array(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );

  const buffer = new Uint8Array(
    preludeLength + headerBytes.length + dataBytes.length,
  );
  const view = new DataView(buffer.buffer);

  buffer.set(encodeAscii("\x93NUMPY"), 0); // magic
  buffer[6] = 1; // major version
  buffer[7] = 0; // minor version
  view.setUint16(8, headerBytes.length, true); // header length, little-endian
  buffer.set(headerBytes, preludeLength);

  // The float32 data is copied out as raw little-endian bytes. TypedArrays are
  // native-endian, but every platform the app runs on is little-endian, which
  // is also what the `<f4` descriptor above declares.
  buffer.set(dataBytes, preludeLength + headerBytes.length);

  return buffer;
}

type ZipEntry = { name: string; data: Uint8Array };

/** Builds a minimal ZIP archive (store method, no compression) holding the
 * given entries, returned as an `ArrayBuffer`. Hand-written to avoid a
 * dependency; the escape-value buffer is float32 that compresses poorly
 * anyway, so storing it is fine. */
export function buildZip(entries: ZipEntry[]): ArrayBuffer {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encodeAscii(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true); // local file header signature
    localView.setUint16(4, 20, true); // version needed to extract
    localView.setUint16(6, 0, true); // general purpose bit flag
    localView.setUint16(8, 0, true); // compression method: 0 = store
    localView.setUint16(10, 0, true); // last mod time
    localView.setUint16(12, 0, true); // last mod date
    localView.setUint32(14, crc, true); // CRC-32
    localView.setUint32(18, size, true); // compressed size
    localView.setUint32(22, size, true); // uncompressed size
    localView.setUint16(26, nameBytes.length, true); // file name length
    localView.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, entry.data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true); // central directory signature
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed to extract
    centralView.setUint16(8, 0, true); // general purpose bit flag
    centralView.setUint16(10, 0, true); // compression method: 0 = store
    centralView.setUint16(12, 0, true); // last mod time
    centralView.setUint16(14, 0, true); // last mod date
    centralView.setUint32(16, crc, true); // CRC-32
    centralView.setUint32(20, size, true); // compressed size
    centralView.setUint32(24, size, true); // uncompressed size
    centralView.setUint16(28, nameBytes.length, true); // file name length
    centralView.setUint16(30, 0, true); // extra field length
    centralView.setUint16(32, 0, true); // file comment length
    centralView.setUint16(34, 0, true); // disk number start
    centralView.setUint16(36, 0, true); // internal file attributes
    centralView.setUint32(38, 0, true); // external file attributes
    centralView.setUint32(42, offset, true); // offset of local header
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);

    offset += localHeader.length + entry.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = offset;

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // end of central directory signature
  endView.setUint16(4, 0, true); // number of this disk
  endView.setUint16(6, 0, true); // disk with central directory
  endView.setUint16(8, entries.length, true); // entries on this disk
  endView.setUint16(10, entries.length, true); // total entries
  endView.setUint32(12, centralSize, true); // central directory size
  endView.setUint32(16, centralOffset, true); // central directory offset
  endView.setUint16(20, 0, true); // comment length

  const totalSize = offset + centralSize + end.length;
  const buffer = new ArrayBuffer(totalSize);
  const result = new Uint8Array(buffer);
  let writeOffset = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    result.set(part, writeOffset);
    writeOffset += part.length;
  }

  return buffer;
}
