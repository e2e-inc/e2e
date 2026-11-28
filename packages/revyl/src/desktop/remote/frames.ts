/**
 * The engine protocol's framing, a `Content-Length` header before each
 * JSON-RPC message, read off a byte stream that arrives in pieces. The
 * runner's relay reads it to know when the server owes an answer, and the
 * server on the Mac reads and rewrites it. Imports nothing but Node, since
 * it is copied to the Mac beside the scripts that use it.
 */

const DELIMITER = Buffer.from('\r\n\r\n', 'ascii');

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

/** Splits a byte stream into frames, keeping a frame cut between chunks for the next chunk. */
export class FrameReader {
  #buffer: Buffer = Buffer.alloc(0);

  /** The frames `chunk` completes, in order. Bytes that are no frame pass through as one, for the peer's own reader to refuse. */
  push(chunk: Buffer): Frame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const end = this.#buffer.indexOf(DELIMITER);
      if (end === -1) return frames;
      const start = end + DELIMITER.length;
      const length = /content-length:\s*(\d+)/i.exec(this.#buffer.subarray(0, end).toString('ascii'))?.[1];
      const size = length === undefined ? start : start + Number(length);
      if (this.#buffer.length < size) return frames;
      const bytes = this.#buffer.subarray(0, size);
      this.#buffer = this.#buffer.subarray(size);
      frames.push({ bytes, message: length === undefined ? undefined : parse(bytes.subarray(start).toString('utf8')) });
    }
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
