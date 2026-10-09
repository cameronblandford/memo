import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoError } from './memos.js';

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const IMAGE_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;

// The type comes from the first bytes of the file, not from a name. SVG is not permitted: it can contain script.
function kind(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'))) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export function createImages(dir) {
  function save(bytes) {
    const b = Buffer.from(bytes);
    if (b.length > MAX_BYTES) throw new MemoError(400, 'An image must be 5 MB or smaller.');
    const ext = kind(b);
    if (!ext) throw new MemoError(400, 'The file must be a PNG, JPEG, GIF, or WebP image.');
    const name = `${createHash('sha256').update(b).digest('hex').slice(0, 16)}.${ext}`;
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), b);
    return { name };
  }
  // Only a name in the stored form goes on to a file path.
  function read(name) {
    if (!IMAGE_NAME.test(name) || !existsSync(join(dir, name))) throw new MemoError(404, 'No image has that name.');
    return { bytes: readFileSync(join(dir, name)), type: TYPES[name.split('.')[1]] };
  }
  return { save, read };
}
