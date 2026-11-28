/**
 * Minimal pure-TypeScript reader for Apple Property List files (`Info.plist`)
 * in both XML and binary (`bplist00`) formats. Used by `e2e doctor` to
 * inspect iOS `.app` bundles without shelling out to `plutil` or adding
 * external dependencies.
 */

export type PlistValue = string | number | boolean | Buffer | Date | readonly PlistValue[] | { readonly [key: string]: PlistValue };

const BPLIST_MAGIC = Buffer.from('bplist00', 'ascii');
const BPLIST_TRAILER_SIZE = 32;

/**
 * Parses an XML or binary (`bplist00`) property list buffer into a JS value.
 * Returns `undefined` if the buffer is empty, an unsupported format, or malformed.
 */
export function parsePlist(data: Buffer): PlistValue | undefined {
  if (data.length >= BPLIST_MAGIC.length && data.subarray(0, BPLIST_MAGIC.length).equals(BPLIST_MAGIC)) {
    return parseBinaryPlist(data);
  }
  const text = data.toString('utf8').trimStart();
  if (text.startsWith('<')) {
    return parseXmlPlist(text);
  }
  return undefined;
}

/** Reads `Info.plist` fields relevant to iOS bundle validation as a plain record. */
export function parsePlistDict(data: Buffer): Readonly<Record<string, PlistValue>> | undefined {
  const value = parsePlist(data);
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Buffer.isBuffer(value) || value instanceof Date) {
    return undefined;
  }
  return value as Readonly<Record<string, PlistValue>>;
}

function parseBinaryPlist(buf: Buffer): PlistValue | undefined {
  if (buf.length < BPLIST_MAGIC.length + BPLIST_TRAILER_SIZE) return undefined;

  const trailerOffset = buf.length - BPLIST_TRAILER_SIZE;
  const offsetIntSize = buf[trailerOffset + 6]!;
  const objectRefSize = buf[trailerOffset + 7]!;
  if (!isValidIntSize(offsetIntSize) || !isValidIntSize(objectRefSize)) return undefined;

  const numObjects = readUInt64AsSafeNumber(buf, trailerOffset + 8);
  const topObject = readUInt64AsSafeNumber(buf, trailerOffset + 16);
  const offsetTableOffset = readUInt64AsSafeNumber(buf, trailerOffset + 24);
  if (numObjects === undefined || topObject === undefined || offsetTableOffset === undefined) return undefined;
  if (numObjects === 0 || topObject >= numObjects) return undefined;
  if (offsetTableOffset < BPLIST_MAGIC.length || offsetTableOffset + numObjects * offsetIntSize > trailerOffset) return undefined;

  const visited = new Set<number>();

  const readOffset = (index: number): number | undefined => {
    if (index < 0 || index >= numObjects) return undefined;
    const offset = readUIntBE(buf, offsetTableOffset + index * offsetIntSize, offsetIntSize);
    if (offset === undefined || offset < BPLIST_MAGIC.length || offset >= offsetTableOffset) return undefined;
    return offset;
  };

  const readLength = (pos: number, info: number): { readonly length: number; readonly dataPos: number } | undefined => {
    if (info !== 0x0f) return { length: info, dataPos: pos };
    if (pos >= offsetTableOffset) return undefined;
    const marker = buf[pos]!;
    if ((marker & 0xf0) !== 0x10) return undefined;
    const byteCount = 1 << (marker & 0x0f);
    if (byteCount > 8 || pos + 1 + byteCount > offsetTableOffset) return undefined;
    const length = readUIntBE(buf, pos + 1, byteCount);
    if (length === undefined) return undefined;
    return { length, dataPos: pos + 1 + byteCount };
  };

  const decode = (index: number): PlistValue | undefined => {
    if (visited.has(index)) return undefined;
    const offset = readOffset(index);
    if (offset === undefined) return undefined;

    visited.add(index);
    try {
      const marker = buf[offset]!;
      const type = (marker & 0xf0) >> 4;
      const info = marker & 0x0f;
      const pos = offset + 1;

      switch (type) {
        case 0x0:
          if (info === 0x08) return false;
          if (info === 0x09) return true;
          return undefined;
        case 0x1: {
          const size = 1 << info;
          if (size > 8 || pos + size > offsetTableOffset) return undefined;
          if (size === 8) return Number(buf.readBigInt64BE(pos));
          return readUIntBE(buf, pos, size);
        }
        case 0x2: {
          const size = 1 << info;
          if (pos + size > offsetTableOffset) return undefined;
          if (size === 4) return buf.readFloatBE(pos);
          if (size === 8) return buf.readDoubleBE(pos);
          return undefined;
        }
        case 0x3: {
          if (pos + 8 > offsetTableOffset) return undefined;
          const seconds = buf.readDoubleBE(pos);
          // Apple Cocoa reference date is 2001-01-01T00:00:00Z (978307200000 ms after Unix epoch).
          return new Date(978307200000 + seconds * 1000);
        }
        case 0x4: {
          const header = readLength(pos, info);
          if (header === undefined || header.dataPos + header.length > offsetTableOffset) return undefined;
          return Buffer.from(buf.subarray(header.dataPos, header.dataPos + header.length));
        }
        case 0x5: {
          const header = readLength(pos, info);
          if (header === undefined || header.dataPos + header.length > offsetTableOffset) return undefined;
          return buf.toString('latin1', header.dataPos, header.dataPos + header.length);
        }
        case 0x6: {
          const header = readLength(pos, info);
          const byteLength = header === undefined ? undefined : header.length * 2;
          if (header === undefined || byteLength === undefined || header.dataPos + byteLength > offsetTableOffset) return undefined;
          return Buffer.from(buf.subarray(header.dataPos, header.dataPos + byteLength)).swap16().toString('utf16le');
        }
        case 0xa:
        case 0xc: {
          const header = readLength(pos, info);
          if (header === undefined || header.dataPos + header.length * objectRefSize > offsetTableOffset) return undefined;
          const items: PlistValue[] = [];
          for (let i = 0; i < header.length; i += 1) {
            const ref = readUIntBE(buf, header.dataPos + i * objectRefSize, objectRefSize);
            if (ref === undefined) return undefined;
            const item = decode(ref);
            if (item === undefined) return undefined;
            items.push(item);
          }
          return items;
        }
        case 0xd: {
          const header = readLength(pos, info);
          if (header === undefined || header.dataPos + header.length * 2 * objectRefSize > offsetTableOffset) return undefined;
          const dict = Object.create(null) as Record<string, PlistValue>;
          const keysOffset = header.dataPos;
          const valuesOffset = header.dataPos + header.length * objectRefSize;
          for (let i = 0; i < header.length; i += 1) {
            const keyRef = readUIntBE(buf, keysOffset + i * objectRefSize, objectRefSize);
            const valRef = readUIntBE(buf, valuesOffset + i * objectRefSize, objectRefSize);
            if (keyRef === undefined || valRef === undefined) return undefined;
            const key = decode(keyRef);
            if (typeof key !== 'string') return undefined;
            const val = decode(valRef);
            if (val !== undefined) dict[key] = val;
          }
          return dict;
        }
        default:
          return undefined;
      }
    } finally {
      visited.delete(index);
    }
  };

  return decode(topObject);
}

function isValidIntSize(size: number): boolean {
  return size === 1 || size === 2 || size === 4 || size === 8;
}

function readUIntBE(buf: Buffer, offset: number, byteLength: number): number | undefined {
  if (offset < 0 || offset + byteLength > buf.length) return undefined;
  switch (byteLength) {
    case 1:
      return buf[offset]!;
    case 2:
      return buf.readUInt16BE(offset);
    case 4:
      return buf.readUInt32BE(offset);
    case 8:
      return readUInt64AsSafeNumber(buf, offset);
    default:
      return undefined;
  }
}

function readUInt64AsSafeNumber(buf: Buffer, offset: number): number | undefined {
  if (offset < 0 || offset + 8 > buf.length) return undefined;
  const value = buf.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(value);
}

function parseXmlPlist(text: string): PlistValue | undefined {
  let cursor = 0;

  const skipTrivia = (): void => {
    while (cursor < text.length) {
      while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
      if (text.startsWith('<?', cursor)) {
        const end = text.indexOf('?>', cursor + 2);
        if (end === -1) return;
        cursor = end + 2;
      } else if (text.startsWith('<!--', cursor)) {
        const end = text.indexOf('-->', cursor + 4);
        if (end === -1) return;
        cursor = end + 3;
      } else if (text.startsWith('<!', cursor)) {
        const end = text.indexOf('>', cursor + 2);
        if (end === -1) return;
        cursor = end + 1;
      } else {
        break;
      }
    }
  };

  const readTag = (): { readonly name: string; readonly selfClosing: boolean; readonly isClosing: boolean } | undefined => {
    skipTrivia();
    if (text[cursor] !== '<') return undefined;
    const end = text.indexOf('>', cursor + 1);
    if (end === -1) return undefined;
    const raw = text.slice(cursor + 1, end).trim();
    cursor = end + 1;
    if (raw.startsWith('/')) {
      return { name: raw.slice(1).trim(), selfClosing: false, isClosing: true };
    }
    const selfClosing = raw.endsWith('/');
    const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
    const space = body.search(/\s/);
    const name = space === -1 ? body : body.slice(0, space);
    return { name, selfClosing, isClosing: false };
  };

  const readTextUntilClose = (tagName: string): string | undefined => {
    const start = cursor;
    const closeTag = `</${tagName}>`;
    const end = text.indexOf(closeTag, start);
    if (end === -1) return undefined;
    const content = text.slice(start, end);
    cursor = end + closeTag.length;
    return unescapeXml(content);
  };

  const parseValue = (): PlistValue | undefined => {
    const tag = readTag();
    if (tag === undefined || tag.isClosing) return undefined;

    switch (tag.name) {
      case 'true':
        return tag.selfClosing ? true : (readTextUntilClose('true') !== undefined ? true : undefined);
      case 'false':
        return tag.selfClosing ? false : (readTextUntilClose('false') !== undefined ? false : undefined);
      case 'string':
        return tag.selfClosing ? '' : readTextUntilClose('string');
      case 'integer': {
        if (tag.selfClosing) return undefined;
        const raw = readTextUntilClose('integer');
        if (raw === undefined) return undefined;
        const n = Number(raw.trim());
        return Number.isFinite(n) ? n : undefined;
      }
      case 'real': {
        if (tag.selfClosing) return undefined;
        const raw = readTextUntilClose('real');
        if (raw === undefined) return undefined;
        const n = Number(raw.trim());
        return Number.isFinite(n) ? n : undefined;
      }
      case 'data': {
        if (tag.selfClosing) return Buffer.alloc(0);
        const raw = readTextUntilClose('data');
        return raw === undefined ? undefined : Buffer.from(raw.replace(/\s+/g, ''), 'base64');
      }
      case 'date': {
        if (tag.selfClosing) return undefined;
        const raw = readTextUntilClose('date');
        if (raw === undefined) return undefined;
        const date = new Date(raw.trim());
        return Number.isNaN(date.getTime()) ? undefined : date;
      }
      case 'array': {
        if (tag.selfClosing) return [];
        const items: PlistValue[] = [];
        while (true) {
          skipTrivia();
          if (text.startsWith('</array>', cursor)) {
            cursor += '</array>'.length;
            return items;
          }
          const item = parseValue();
          if (item === undefined) return undefined;
          items.push(item);
        }
      }
      case 'dict': {
        if (tag.selfClosing) return Object.create(null) as Record<string, PlistValue>;
        const dict = Object.create(null) as Record<string, PlistValue>;
        while (true) {
          skipTrivia();
          if (text.startsWith('</dict>', cursor)) {
            cursor += '</dict>'.length;
            return dict;
          }
          const keyTag = readTag();
          if (keyTag === undefined || keyTag.isClosing || keyTag.name !== 'key') return undefined;
          const key = keyTag.selfClosing ? '' : readTextUntilClose('key');
          if (key === undefined) return undefined;
          const val = parseValue();
          if (val === undefined) return undefined;
          dict[key] = val;
        }
      }
      default:
        return undefined;
    }
  };

  const root = readTag();
  if (root === undefined || root.isClosing || root.name !== 'plist' || root.selfClosing) return undefined;
  const value = parseValue();
  if (value === undefined) return undefined;
  const close = readTag();
  if (close === undefined || !close.isClosing || close.name !== 'plist') return undefined;
  return value;
}

function unescapeXml(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const codePoint = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
      }
    }
  });
}
