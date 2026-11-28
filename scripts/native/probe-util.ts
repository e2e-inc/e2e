/**
 * Loads a build of `@e2e-dev/util`'s addon and round-trips a pixel through
 * it: encode on the native pool, decode, read back. CI runs it on every
 * platform the addon ships for, in the Node a user on that platform runs
 * (an x86_64 Node under Rosetta for the Intel Mac build).
 *
 * Usage: `node scripts/native/probe-util.ts <path to util.<platform>.node>`.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

interface Image {
  readonly width: number;
  readonly height: number;
  pixels(): Buffer;
  encode(): Promise<Buffer>;
}

interface Binding {
  readonly NativeImage: { fromRgba(data: Uint8Array, width: number, height: number): Image };
  decodePng(bytes: Uint8Array): Promise<Image>;
}

const file = process.argv[2];
if (file === undefined) throw new Error('usage: probe-util.ts <addon file>');
const addon = createRequire(import.meta.url)(path.resolve(file)) as Binding;
const pixel = [12, 34, 56, 255];
const png = await addon.NativeImage.fromRgba(Uint8Array.from(pixel), 1, 1).encode();
const decoded = await addon.decodePng(png);
const read = [...decoded.pixels()];
if (decoded.width !== 1 || decoded.height !== 1 || read.join() !== pixel.join()) {
  throw new Error(`the round trip gave ${decoded.width}x${decoded.height} [${read.join(', ')}], not 1x1 [${pixel.join(', ')}]`);
}
process.stdout.write(`${path.basename(file)} loads in Node ${process.version} (${process.platform}-${process.arch}) and round-trips a pixel\n`);
