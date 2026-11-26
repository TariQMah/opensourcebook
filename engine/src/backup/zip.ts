/**
 * A zip file, written as it is sent and read back by parts, for a backup of every project (backup.ts). Entries are
 * stored as they are, not compressed: most of a backup is video, pictures and PDFs, which are compressed already, and
 * stored entries can be written as they stream in. Any zip program opens the file. Past 4 GB the file carries the zip64
 * records every current zip program reads; one entry is at most 4 GB.
 */

const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
/** Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0808;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

let table: Uint32Array | undefined;
function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 of the bytes, carried on from `crc` (the CRC of what came before), as zip keeps it. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  const t = crcTable();
  let c = (crc ^ MAX32) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class Bytes {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  private at = 0;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(v: number): this {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
    return this;
  }
  u32(v: number): this {
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(v: number): this {
    this.view.setBigUint64(this.at, BigInt(v), true);
    this.at += 8;
    return this;
  }
  raw(b: Uint8Array): this {
    this.bytes.set(b, this.at);
    this.at += b.length;
    return this;
  }
}

interface Written {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

/** Writes a zip into a stream, one entry after another; `finish` writes the directory at the end and closes it. */
export class ZipWriter {
  private readonly written: Written[] = [];
  private offset = 0;
  private readonly stamp = dosTime(new Date());
  private readonly names = new Set<string>();

  constructor(private readonly out: WritableStreamDefaultWriter<Uint8Array>) {}

  private async send(bytes: Uint8Array): Promise<void> {
    await this.out.write(bytes);
    this.offset += bytes.length;
  }

  /** Adds one entry: text, bytes, or a stream of bytes read as it is written. */
  async add(path: string, data: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    if (this.names.has(path)) throw new Error(`The zip already has ${path}`);
    this.names.add(path);
    const name = new TextEncoder().encode(path);
    const offset = this.offset;
    await this.send(
      new Bytes(30 + name.length).u32(LOCAL).u16(20).u16(FLAGS).u16(0).u16(this.stamp.time).u16(this.stamp.date).u32(0).u32(0).u32(0).u16(name.length).u16(0).raw(name).bytes,
    );
    let crc = 0;
    let size = 0;
    const chunk = async (bytes: Uint8Array) => {
      crc = crc32(bytes, crc);
      size += bytes.length;
      if (size > MAX32 - 1) throw new Error(`${path} is larger than one entry of a zip can be (4 GB)`);
      await this.send(bytes);
    };
    if (typeof data === "string") await chunk(new TextEncoder().encode(data));
    else if (data instanceof Uint8Array) await chunk(data);
    else {
      const reader = data.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) await chunk(value);
      }
    }
    await this.send(new Bytes(16).u32(DESCRIPTOR).u32(crc).u32(size).u32(size).bytes);
    this.written.push({ name, crc, size, offset });
  }

  async finish(): Promise<void> {
    const start = this.offset;
    for (const entry of this.written) {
      const big = entry.offset >= MAX32;
      const extra = big ? 12 : 0;
      const record = new Bytes(46 + entry.name.length + extra)
        .u32(CENTRAL)
        .u16(big ? 45 : 20)
        .u16(big ? 45 : 20)
        .u16(FLAGS)
        .u16(0)
        .u16(this.stamp.time)
        .u16(this.stamp.date)
        .u32(entry.crc)
        .u32(entry.size)
        .u32(entry.size)
        .u16(entry.name.length)
        .u16(extra)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(0)
        .u32(big ? MAX32 : entry.offset)
        .raw(entry.name);
      if (big) record.u16(0x0001).u16(8).u64(entry.offset);
      await this.send(record.bytes);
    }
    const size = this.offset - start;
    const count = this.written.length;
    const big = start >= MAX32 || size >= MAX32 || count >= MAX16;
    if (big) {
      const end64 = this.offset;
      await this.send(new Bytes(56).u32(END64).u64(44).u16(45).u16(45).u32(0).u32(0).u64(count).u64(count).u64(size).u64(start).bytes);
      await this.send(new Bytes(20).u32(LOCATOR64).u32(0).u64(end64).u32(1).bytes);
    }
    await this.send(
      new Bytes(22)
        .u32(END)
        .u16(0)
        .u16(0)
        .u16(big ? MAX16 : count)
        .u16(big ? MAX16 : count)
        .u32(big ? MAX32 : size)
        .u32(big ? MAX32 : start)
        .u16(0).bytes,
    );
    await this.out.close();
  }
}

/** One entry of a zip being read: where its stored bytes are, how many, and their CRC. */
export interface ZipEntry {
  name: string;
  /** Where the entry's local header starts. */
  header: number;
  size: number;
  crc: number;
  /** 0 stored, 8 deflated; only stored entries are read here. */
  method: number;
}

/** Reads `length` bytes at `offset` of the file. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

export class ZipError extends Error {}

/** The entries of a zip, read from its directory at the end; nothing else of the file is read. */
export async function readZipDirectory(size: number, readAt: ReadAt): Promise<Map<string, ZipEntry>> {
  if (size < 22) throw new ZipError("This is not a zip file.");
  const tailLength = Math.min(size, 22 + MAX16 + 20);
  const tail = await readAt(size - tailLength, tailLength);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError("This is not a zip file (it has no directory at its end).");
  let count = view.getUint16(end + 10, true);
  let dirSize = view.getUint32(end + 12, true);
  let dirStart = view.getUint32(end + 16, true);
  if (end >= 20 && view.getUint32(end - 20, true) === LOCATOR64) {
    const end64 = Number(view.getBigUint64(end - 20 + 8, true));
    const record = await readAt(end64, 56);
    const r = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (r.getUint32(0, true) !== END64) throw new ZipError("The zip's directory could not be read.");
    count = Number(r.getBigUint64(32, true));
    dirSize = Number(r.getBigUint64(40, true));
    dirStart = Number(r.getBigUint64(48, true));
  }
  if (dirStart + dirSize > size) throw new ZipError("The zip file is cut short.");
  const dir = await readAt(dirStart, dirSize);
  const d = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries = new Map<string, ZipEntry>();
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > dir.length || d.getUint32(at, true) !== CENTRAL) throw new ZipError("The zip's directory could not be read.");
    const method = d.getUint16(at + 10, true);
    const crc = d.getUint32(at + 16, true);
    let compressed = d.getUint32(at + 20, true);
    let plain = d.getUint32(at + 24, true);
    const nameLength = d.getUint16(at + 28, true);
    const extraLength = d.getUint16(at + 30, true);
    const commentLength = d.getUint16(at + 32, true);
    let header = d.getUint32(at + 42, true);
    const name = new TextDecoder().decode(dir.subarray(at + 46, at + 46 + nameLength));
    // A zip64 extra field holds, in order, whichever of the sizes and the offset did not fit.
    let x = at + 46 + nameLength;
    const xEnd = x + extraLength;
    while (x + 4 <= xEnd) {
      const id = d.getUint16(x, true);
      const length = d.getUint16(x + 2, true);
      if (id === 0x0001) {
        let f = x + 4;
        if (plain === MAX32) (plain = Number(d.getBigUint64(f, true))), (f += 8);
        if (compressed === MAX32) (compressed = Number(d.getBigUint64(f, true))), (f += 8);
        if (header === MAX32) header = Number(d.getBigUint64(f, true));
      }
      x += 4 + length;
    }
    entries.set(name, { name, header, size: compressed, crc, method });
    at = xEnd + commentLength;
  }
  return entries;
}

/** Where an entry's stored bytes start: after its local header, whose name and extra field may differ in length. */
export async function entryStart(entry: ZipEntry, readAt: ReadAt): Promise<number> {
  const local = await readAt(entry.header, 30);
  const v = new DataView(local.buffer, local.byteOffset, local.byteLength);
  if (v.getUint32(0, true) !== LOCAL) throw new ZipError(`The zip's entry ${entry.name} could not be read.`);
  return entry.header + 30 + v.getUint16(26, true) + v.getUint16(28, true);
}

/** A stored entry's whole bytes, checked against its CRC. */
export async function readEntry(entry: ZipEntry, readAt: ReadAt): Promise<Uint8Array> {
  if (entry.method !== 0) throw new ZipError(`${entry.name} is compressed; a backup's entries are stored as they are.`);
  const bytes = await readAt(await entryStart(entry, readAt), entry.size);
  if (crc32(bytes) !== entry.crc) throw new ZipError(`${entry.name} in the zip is damaged.`);
  return bytes;
}
