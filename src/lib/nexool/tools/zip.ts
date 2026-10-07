/**
 * NexTool v1.0.13 §2 — pure-TypeScript ZIP writer for the FS Inspector.
 *
 * `createZip(files)` produces a spec-conforming ZIP archive (a Buffer) from an
 * in-memory list of files, preserving whatever hierarchy the caller encoded in
 * each `path` (forward-slash separated, rooted at the archive root).
 *
 * Implementation notes (APPNOTE.TXT):
 *  - Local file headers (0x04034b50) + central directory (0x02014b50) +
 *    end-of-central-directory record (0x06054b50), no ZIP64 (the FS Inspector
 *    caps total uncompressed payload at 256 MiB, far below the 4 GiB boundary).
 *  - Entry payloads are DEFLATE-compressed with node:zlib.deflateRawSync;
 *    entries where compression does not shrink the payload are STORED (method 0).
 *  - Bit 11 (0x0800) is set on every entry: filenames are UTF-8.
 *  - CRC32 uses the standard reflected polynomial 0xEDB88320 via a lookup table.
 *  - Timestamps are MS-DOS format (2s resolution, year ≥ 1980 enforced).
 */

import { deflateRawSync } from 'node:zlib';

/** Hard cap mirroring the FS Inspector download/zip policy (256 MiB). */
export const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

/** Standard CRC-32 lookup table (reflected, polynomial 0xEDB88320). */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed time/date. Years before 1980 are clamped to 1980-01-01. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Zip entry names always use forward slashes and never start with one. */
function zipEntryName(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

export interface ZipInputFile {
  /** Archive path — hierarchy is encoded with forward slashes (e.g. `dir/sub/a.txt`). */
  path: string;
  /** Raw uncompressed payload. */
  data: Buffer;
  /** Optional modification timestamp (defaults to now). */
  mtime?: Date;
}

/**
 * Build a ZIP archive from an in-memory file list. Throws when the total
 * uncompressed payload exceeds ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES (the caller's
 * contract keeps the archive ZIP64-free).
 */
export function createZip(files: ZipInputFile[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let totalUncompressed = 0;
  const now = new Date();

  for (const file of files) {
    const name = zipEntryName(file.path);
    if (name.length === 0) continue; // nothing to store
    if (totalUncompressed + file.data.length > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(
        `ZIP payload exceeds the maximum total uncompressed size of ${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes.`,
      );
    }
    totalUncompressed += file.data.length;

    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(file.data);
    const { time, date } = dosDateTime(file.mtime ?? now);

    // DEFLATE, unless compression does not actually shrink the payload.
    let method = 8;
    let payload: Buffer = file.data;
    try {
      const deflated = deflateRawSync(file.data, { level: 6 });
      if (deflated.length < file.data.length) payload = deflated;
      else method = 0;
    } catch {
      method = 0; // honest fallback: store the raw bytes
    }

    // --- local file header ---
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 filenames
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18); // compressed size
    local.writeUInt32LE(file.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    chunks.push(local, nameBuf, payload);

    // --- central directory record ---
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(file.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central directory size
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}
