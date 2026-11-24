import { crc32, deflateSync } from "node:zlib";

export function seededPng(seed: number): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const typeAndData = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, seed, seed * 3, seed * 7]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
