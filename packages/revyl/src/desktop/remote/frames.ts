/**
 * The engine protocol's framing, a `Content-Length` header before each
 * JSON-RPC message, read off a byte stream that arrives in pieces. The
 * runner's relay reads it to know when the server owes an answer, and the
 * server on the Mac reads and rewrites it. Imports nothing but Node, since
 * it is copied to the Mac beside the scripts that use it.
 */

const DELIMITER = Buffer.from('\r\n\r\n', 'ascii');
/** The largest message body a reader takes: far above a screenshot's, so a length past it is a broken stream, not a message. */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** A JSON-RPC message, as far as framing needs to know it. */
export interface Message {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** One frame: its bytes as they arrived, and its message when the body is a JSON object. */
export interface Frame {
  readonly bytes: Buffer;
  readonly message: Message | undefined;
}

/**
 * Splits a byte stream into frames, keeping a frame cut between chunks for
 * the next chunk. The pieces of a frame are joined once it is whole, not on
 * every chunk.
 */
export class FrameReader {
  #pieces: Buffer[] = [];
  #length = 0;
  /** Bytes the frame at the front needs in all, once its header is read. */
  #needed = 0;

  /** The frames `chunk` completes, in order. Bytes that are no frame pass through as one, for the peer's own reader to refuse. A body longer than 256 MiB throws. */
  push(chunk: Buffer): Frame[] {
    this.#pieces.push(chunk);
    this.#length += chunk.length;
    if (this.#length < this.#needed) return [];
    let buffer = this.#pieces.length === 1 ? this.#pieces[0]! : Buffer.concat(this.#pieces, this.#length);
    const frames: Frame[] = [];
    this.#needed = 0;
    for (;;) {
      const end = buffer.indexOf(DELIMITER);
      if (end === -1) break;
      const start = end + DELIMITER.length;
      const length = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1];
      if (length !== undefined && Number(length) > MAX_BODY_BYTES) throw new Error(`a frame declares ${length} body bytes, over the ${MAX_BODY_BYTES} a message may have`);
      const size = length === undefined ? start : start + Number(length);
      if (buffer.length < size) {
        this.#needed = size;
        break;
      }
      const bytes = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      frames.push({ bytes, message: length === undefined ? undefined : parse(bytes.subarray(start).toString('utf8')) });
    }
    this.#pieces = buffer.length === 0 ? [] : [buffer];
    this.#length = buffer.length;
    return frames;
  }
}

/** One message as the bytes the protocol carries. */
export function frame(message: Message): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function parse(body: string): Message | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
}
