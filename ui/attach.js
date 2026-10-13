// The rules for an image that the owner attaches to a memo. This file has no DOM code, so a test and the
// command-line client can import it.

export const MAX_BYTES = 5 * 1024 * 1024; // the limit of the server (src/images.js)
export const MAX_SIDE = 2400; // the longest side of an image that the browser makes smaller, in pixels
const SMALL_BYTES = 1.5 * 1024 * 1024;
const STORED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const IMAGE_LINK = /!\[[^\]\n]*\]\(image:([0-9a-f]{16}\.(?:png|jpg|gif|webp))\)/g;

// True if the browser sends the file with no change. A GIF can move, so it stays a GIF. A large photo and a type
// that the server does not store (HEIC, for example) become a smaller JPEG first.
export function sendsAsIs(type, size) {
  if (type === 'image/gif') return size <= MAX_BYTES;
  return STORED_TYPES.includes(type) && size <= SMALL_BYTES;
}

// The size of an image after the browser makes it fit in a square of `max` pixels. A small image keeps its size.
export function fit(width, height, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// The text of a field after an image is attached: the image is a Markdown line at the end.
export function withImage(text, name) {
  const line = `![image](image:${name})`;
  return text.trim() ? `${text.replace(/\s+$/, '')}\n\n${line}\n` : `${line}\n`;
}

// The names of the stored images that a text shows, each name one time.
export function imageNames(text) {
  return [...new Set([...String(text || '').matchAll(IMAGE_LINK)].map((m) => m[1]))];
}
