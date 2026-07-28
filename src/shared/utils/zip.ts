import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { finished } from 'node:stream/promises';
import { nanoid } from 'nanoid';

/** Describes a single file to include in a new ZIP archive. */
export type ZipInputFile = {
  /** Absolute path to the file on disk. */
  tempPath: string;
  /** Original file name (used to derive the ZIP entry name). */
  fileName: string;
};

/** Metadata for one entry in a created ZIP archive. */
export type ZipEntry = {
  /** Original file name as passed to `ZipInputFile`. */
  fileName: string;
  /** Sanitised entry name within the archive. */
  entryName: string;
  /** CRC-32 checksum of the uncompressed data. */
  crc32: number;
  /** Size of the entry when compressed (stored size). */
  compressedSize: number;
  /** Size of the uncompressed data. */
  uncompressedSize: number;
  /** Byte offset of the local file header in the archive. */
  localHeaderOffset: number;
};

/** Result returned after creating a ZIP archive. */
export type CreatedZip = {
  /** Absolute path to the temporary ZIP file on disk. */
  tempPath: string;
  /** Total size of the archive in bytes. */
  sizeBytes: number;
  /** SHA-256 hex digest of the entire archive content. */
  fileHash: string;
  /** Metadata for every entry in the archive. */
  entries: ZipEntry[];
};

/** Pre-computed CRC-32 lookup table (ISO 3309 / IEEE 802.3 polynomial). */
const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/**
 * Updates a running CRC-32 checksum with the bytes of a buffer.
 *
 * @param crc - Current CRC-32 value (typically starts at `0xFFFFFFFF`).
 * @param chunk - Buffer of bytes to incorporate.
 * @returns The updated CRC-32 value.
 */
const updateCrc32 = (crc: number, chunk: Buffer): number => {
  let value = crc;
  for (const byte of chunk) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
};

/**
 * Converts a JavaScript Date into the MS-DOS date/time format used by ZIP
 * local file headers.
 *
 * @param date - The date to convert (defaults to the current time).
 * @returns An object with separate `time` and `date` bit-fields.
 */
const dosDateTime = (date = new Date()): { date: number; time: number } => {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

/**
 * Writes a 16-bit unsigned integer as a little-endian buffer.
 *
 * @param value - The integer to write (only the lower 16 bits are used).
 * @returns A 2-byte buffer.
 */
const writeUInt16 = (value: number): Buffer<ArrayBuffer> => {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
};

/**
 * Writes a 32-bit unsigned integer as a little-endian buffer.
 *
 * @param value - The integer to write (interpreted as unsigned).
 * @returns A 4-byte buffer.
 */
const writeUInt32 = (value: number): Buffer<ArrayBuffer> => {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
};

/**
 * Writes a chunk of data to a writable stream, waiting for the drain event
 * if the internal buffer is full (back-pressure handling).
 *
 * @param writer - The writable stream (e.g. `createWriteStream` result).
 * @param chunk  - The buffer to write.
 */
const writeChunk = async (
  writer: ReturnType<typeof createWriteStream>,
  chunk: Buffer,
): Promise<void> => {
  if (!writer.write(chunk)) {
    await once(writer, 'drain');
  }
};

/**
 * Finishes a writable stream and waits for it to close.
 *
 * @param writer - The writable stream to end.
 */
const finishWriter = async (writer: ReturnType<typeof createWriteStream>): Promise<void> => {
  writer.end();
  await finished(writer);
};

/**
 * Sanitises a file name for use as a ZIP entry name.
 *
 * Strips directory components, replaces path separators with underscores,
 * collapses consecutive dots, and ensures uniqueness against the supplied
 * set of already-used names by appending a numeric suffix when necessary.
 *
 * @param fileName  - The raw file name to sanitise.
 * @param usedNames - A set of entry names already claimed; may be mutated.
 * @returns A unique, safe ZIP entry name.
 */
export const sanitizeZipEntryName = (fileName: string, usedNames = new Set<string>()): string => {
  const cleaned = basename(fileName)
    .replace(/[\\/]+/g, '_')
    .replace(/\.\.+/g, '.')
    .trim();
  const fallback = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
  const dotIndex = fallback.lastIndexOf('.');
  const baseName = dotIndex > 0 ? fallback.slice(0, dotIndex) : fallback;
  const extension = dotIndex > 0 ? fallback.slice(dotIndex) : '';
  let candidate = fallback;
  let counter = 1;

  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${counter}${extension}`;
    counter++;
  }

  usedNames.add(candidate);
  return candidate;
};

/**
 * Calculates the CRC-32 checksum of a file on disk by streaming its
 * contents through the lookup-table algorithm.
 *
 * @param tempPath - Absolute path to the file.
 * @returns The CRC-32 value as an unsigned 32-bit integer.
 */
const calculateFileCrc32 = async (tempPath: string): Promise<number> => {
  let crc = 0xffffffff;
  const reader = createReadStream(tempPath);
  for await (const chunk of reader) {
    crc = updateCrc32(crc, chunk as Buffer);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * Creates a ZIP archive (stored-only, no compression) from a list of input
 * files and writes it to a temporary path.
 *
 * The archive uses the standard ZIP format with local file headers, a
 * central directory, and an end-of-central-directory record. Each entry is
 * stored uncompressed (method 0). The entire archive is SHA-256 hashed
 * during writing.
 *
 * @param files - Array of file descriptors to include in the archive.
 * @returns Metadata describing the created archive.
 */
export const createZip = async (files: ZipInputFile[]): Promise<CreatedZip> => {
  const tempPath = `/tmp/filedrop-${nanoid()}.zip`;
  const writer = createWriteStream(tempPath);
  const hasher = new Bun.CryptoHasher('sha256');
  const entries: ZipEntry[] = [];
  const usedNames = new Set<string>();
  let offset = 0;

  const writeHashed = async (chunk: Buffer): Promise<void> => {
    hasher.update(chunk);
    await writeChunk(writer, chunk);
    offset += chunk.byteLength;
  };

  try {
    for (const file of files) {
      const entryName = sanitizeZipEntryName(file.fileName, usedNames);
      const nameBuffer = Buffer.from(entryName);
      const fileStats = await stat(file.tempPath);
      const { date, time } = dosDateTime();
      const localHeaderOffset = offset;
      const crc32 = await calculateFileCrc32(file.tempPath);

      const localHeader = Buffer.concat([
        writeUInt32(0x04034b50),
        writeUInt16(20),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(time),
        writeUInt16(date),
        writeUInt32(crc32),
        writeUInt32(fileStats.size),
        writeUInt32(fileStats.size),
        writeUInt16(nameBuffer.byteLength),
        writeUInt16(0),
        nameBuffer,
      ]);

      await writeHashed(localHeader);
      const reader = createReadStream(file.tempPath);
      for await (const chunk of reader) {
        await writeHashed(chunk as Buffer);
      }

      entries.push({
        fileName: file.fileName,
        entryName,
        crc32,
        compressedSize: fileStats.size,
        uncompressedSize: fileStats.size,
        localHeaderOffset,
      });
    }

    const centralDirectoryOffset = offset;
    for (const entry of entries) {
      const nameBuffer = Buffer.from(entry.entryName);
      const { date, time } = dosDateTime();
      await writeHashed(
        Buffer.concat([
          writeUInt32(0x02014b50),
          writeUInt16(20),
          writeUInt16(20),
          writeUInt16(0),
          writeUInt16(0),
          writeUInt16(time),
          writeUInt16(date),
          writeUInt32(entry.crc32),
          writeUInt32(entry.compressedSize),
          writeUInt32(entry.uncompressedSize),
          writeUInt16(nameBuffer.byteLength),
          writeUInt16(0),
          writeUInt16(0),
          writeUInt16(0),
          writeUInt16(0),
          writeUInt32(0),
          writeUInt32(entry.localHeaderOffset),
          nameBuffer,
        ]),
      );
    }

    const centralDirectorySize = offset - centralDirectoryOffset;
    await writeHashed(
      Buffer.concat([
        writeUInt32(0x06054b50),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(entries.length),
        writeUInt16(entries.length),
        writeUInt32(centralDirectorySize),
        writeUInt32(centralDirectoryOffset),
        writeUInt16(0),
      ]),
    );

    await finishWriter(writer);

    return {
      tempPath,
      sizeBytes: offset,
      fileHash: hasher.digest('hex'),
      entries,
    };
  } catch (error) {
    writer.destroy();
    throw error;
  }
};

/**
 * Extracts a single entry from an in-memory ZIP buffer.
 *
 * Only stored (uncompressed) entries are supported — entries compressed
 * with any method return `null`.
 *
 * @param zipBuffer - The full ZIP archive as a buffer.
 * @param entryName - The exact entry name to extract.
 * @returns The entry's data as a buffer, or `null` if not found or
 *          compressed.
 */
export const extractZipEntry = async (
  zipBuffer: Buffer,
  entryName: string,
): Promise<Buffer | null> => {
  let offset = 0;

  while (offset + 30 <= zipBuffer.byteLength) {
    const signature = zipBuffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraLength = zipBuffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    const currentName = zipBuffer.subarray(nameStart, nameEnd).toString();

    if (currentName === entryName) {
      if (compressionMethod !== 0) return null;
      return zipBuffer.subarray(dataStart, dataEnd);
    }

    offset = dataEnd;
  }

  return null;
};

/** Byte-range location of a stored entry within a ZIP archive on disk. */
export type LocatedZipEntry = {
  /** Byte offset where the entry data begins. */
  start: number;
  /** Length of the entry data in bytes. */
  length: number;
};

/**
 * Locates a stored (uncompressed) entry within a ZIP archive on disk
 * without reading the entire file into memory.
 *
 * Scans local file headers sequentially until the matching entry is found
 * or the end of valid headers is reached.
 *
 * @param zipPath   - Absolute path to the ZIP file on disk.
 * @param entryName - The exact entry name to locate.
 * @returns The byte range of the entry, or `null` if not found or
 *          compressed.
 */
export const locateZipEntry = async (
  zipPath: string,
  entryName: string,
): Promise<LocatedZipEntry | null> => {
  const handle = await open(zipPath, 'r');
  let offset = 0;

  try {
    const header = Buffer.alloc(30);

    while (true) {
      const { bytesRead } = await handle.read(header, 0, header.byteLength, offset);
      if (bytesRead < header.byteLength) return null;

      const signature = header.readUInt32LE(0);
      if (signature !== 0x04034b50) return null;

      const compressionMethod = header.readUInt16LE(8);
      const compressedSize = header.readUInt32LE(18);
      const fileNameLength = header.readUInt16LE(26);
      const extraLength = header.readUInt16LE(28);
      const nameBuffer = Buffer.alloc(fileNameLength);
      const nameOffset = offset + 30;
      await handle.read(nameBuffer, 0, fileNameLength, nameOffset);

      const dataStart = nameOffset + fileNameLength + extraLength;
      if (nameBuffer.toString() === entryName) {
        if (compressionMethod !== 0) return null;
        return { start: dataStart, length: compressedSize };
      }

      offset = dataStart + compressedSize;
    }
  } finally {
    await handle.close();
  }
};