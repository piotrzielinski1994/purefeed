import { crc32, deflateRawSync } from 'node:zlib';

export type ZipEntry = { name: string; data: Uint8Array };

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIR = 0x06054b50;
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const DEFLATE = 8;
const DOS_DATE_1980_01_01 = 0x21;

type PackedEntry = { name: Buffer; crc: number; size: number; compressed: Buffer };

function localHeader(entry: PackedEntry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_HEADER, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(DEFLATE, 8);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed.length, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  return Buffer.concat([header, entry.name]);
}

function centralHeader(entry: PackedEntry, offset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_HEADER, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(VERSION, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(DEFLATE, 10);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed.length, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, entry.name]);
}

export function createZip(entries: readonly ZipEntry[]): Buffer {
  const packed = entries.map(({ name, data }) => ({
    name: Buffer.from(name, 'utf8'),
    crc: crc32(data),
    size: data.length,
    compressed: deflateRawSync(data),
  }));
  const localRecords = packed.map((entry) => Buffer.concat([localHeader(entry), entry.compressed]));
  const offsets = localRecords.map((_, i) => localRecords.slice(0, i).reduce((sum, record) => sum + record.length, 0));
  const body = Buffer.concat(localRecords);
  const centralDir = Buffer.concat(packed.map((entry, i) => centralHeader(entry, offsets[i])));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIR, 0);
  end.writeUInt16LE(packed.length, 8);
  end.writeUInt16LE(packed.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, centralDir, end]);
}
