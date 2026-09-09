import { inflateRawSync } from "node:zlib";

export const OFFICIAL_BINANCE_KLINE_COLUMNS = [
  "open_time",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "close_time",
  "quote_volume",
  "count",
  "taker_buy_volume",
  "taker_buy_quote_volume",
  "ignore",
] as const;

export interface KlineSchemaValidation {
  passed: boolean;
  conflicts: string[];
}

export function validateKlineSchema(
  headerFields: string[] | null,
  rowFieldCounts: number[],
): KlineSchemaValidation {
  const conflicts: string[] = [];
  if (headerFields !== null) {
    const normalized = headerFields.map((field) => field.trim());
    if (normalized.length !== OFFICIAL_BINANCE_KLINE_COLUMNS.length
      || normalized.some((field, index) => field !== OFFICIAL_BINANCE_KLINE_COLUMNS[index])) {
      conflicts.push("HEADER_FIELDS_MISMATCH");
    }
  }
  for (const fieldCount of rowFieldCounts) {
    if (fieldCount !== OFFICIAL_BINANCE_KLINE_COLUMNS.length) conflicts.push(`UNEXPECTED_COLUMN_COUNT:${fieldCount}`);
  }
  return { passed: conflicts.length === 0, conflicts: [...new Set(conflicts)] };
}

export function isCompletePitBar(openTime: number, closeTime: number, resolutionMs: number): boolean {
  return Number.isInteger(openTime)
    && Number.isInteger(closeTime)
    && Number.isInteger(resolutionMs)
    && resolutionMs > 0
    && closeTime >= openTime + resolutionMs - 1;
}

export interface FamilyAlignment {
  expected: number;
  valid: number;
  incomplete: number;
  validTimestamps: number[];
}

export function alignFamilyTimestamps(
  expectedTimestamps: Iterable<number>,
  familyTimestamps: ReadonlyArray<ReadonlySet<number>>,
): FamilyAlignment {
  const expected = [...new Set(expectedTimestamps)].sort((left, right) => left - right);
  const validTimestamps = expected.filter((timestamp) => familyTimestamps.every((timestamps) => timestamps.has(timestamp)));
  return {
    expected: expected.length,
    valid: validTimestamps.length,
    incomplete: expected.length - validTimestamps.length,
    validTimestamps,
  };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

export function extractZipCsv(buffer: Buffer): string {
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new Error("ZIP_END_OF_CENTRAL_DIRECTORY_NOT_FOUND");
  if (end + 22 > buffer.length) throw new Error("ZIP_END_OF_CENTRAL_DIRECTORY_TRUNCATED");
  const count = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("ZIP_CENTRAL_DIRECTORY_INVALID");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    const name = buffer.subarray(cursor + 46, nameEnd).toString("utf8");
    if (name.toLowerCase().endsWith(".csv")) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error("ZIP_LOCAL_HEADER_INVALID");
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataStart < 0 || dataEnd > buffer.length) throw new Error("ZIP_DATA_TRUNCATED");
      const compressed = buffer.subarray(dataStart, dataEnd);
      const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (content === null) throw new Error(`ZIP_COMPRESSION_UNSUPPORTED_${String(method)}`);
      return content.toString("utf8");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("ZIP_CSV_NOT_FOUND");
}
