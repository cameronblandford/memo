// Code that the two Memo pages share. All text goes into the page as text nodes, never as markup.
import { MAX_BYTES, MAX_SIDE, sendsAsIs, fit, withImage, imageNames } from '/ui/attach.js';

const KEY = 'memo-token';
let memory = '';
const readToken = () => { try { return localStorage.getItem(KEY) || memory; } catch { return memory; } };
const saveToken = (value) => { memory = value; try { localStorage.setItem(KEY, value); } catch { /* a private window: keep it in memory */ } };

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

export function button(label, onClick, title = '') {
  const node = el('button', { type: 'button', title }, label);
  node.addEventListener('click', (event) => { event.stopPropagation(); onClick(node); });
  return node;
}

export function note(message) {
  const node = document.getElementById('note');
  node.textContent = message;
  node.hidden = !message;
}

export async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${readToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    document.getElementById('token-form').hidden = false;
    throw new Error('Enter the token. To copy it, run this in the Memo directory: sed -n "s/^MEMO_TOKEN=//p" .env | tr -d "\\n" | pbcopy');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The request failed with status ${response.status}.`);
  return data;
}

export function tokenForm(onSaved) {
  const form = document.getElementById('token-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveToken(form.elements.token.value.trim());
    form.elements.token.value = '';
    form.hidden = true;
    note('');
    onSaved();
  });
}

export function age(iso) {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 90) return 'now';
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

// Images of memos (<img data-image="name">, made by markdown.js). The request needs the token, so the page
// gets each file itself and gives the element a local address. One request for each image name.
const imageUrls = new Map();
export function loadImages(root) {
  for (const img of root.querySelectorAll('img[data-image]')) {
    const name = img.dataset.image;
    if (!imageUrls.has(name)) {
      imageUrls.set(name, fetch(`/api/image/${name}`, { headers: { Authorization: `Bearer ${readToken()}` } })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('no image'))))
        .then((blob) => URL.createObjectURL(blob))
        .catch(() => { imageUrls.delete(name); return ''; }));
    }
    imageUrls.get(name).then((url) => {
      if (url) img.src = url;
      else img.replaceWith(`[The image "${img.alt}" did not load.]`);
    });
    img.addEventListener('click', () => { if (img.src) window.open(img.src, '_blank', 'noopener'); });
  }
}

// A photo from a phone can be 12 megapixels, or a type that the server does not store. The browser makes a JPEG
// that fits the limits. It tries smaller sizes until the file is small enough.
async function toJpeg(file) {
  let source;
  try { source = await createImageBitmap(file); } catch {
    throw new Error('This browser cannot read the image. Use a PNG or JPEG file.');
  }
  for (const [side, quality] of [[MAX_SIDE, 0.85], [1800, 0.8], [1200, 0.7]]) {
    const size = fit(source.width, source.height, side);
    const canvas = el('canvas', size);
    canvas.getContext('2d').drawImage(source, 0, 0, size.width, size.height);
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error('The image is too large.');
}

// Stores one image file in Memo and gives its name.
export async function uploadImage(file) {
  const body = sendsAsIs(file.type, file.size) ? file : await toJpeg(file);
  const r = await fetch('/api/image', { method: 'POST', headers: { Authorization: `Bearer ${readToken()}` }, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `The image was not stored (status ${r.status}).`);
  return data.name;
}

// Lets the owner attach images to the text of `area`: with the icon in the field, with a paste, and with a drop.
// The function gives a box that contains the field and the icon; put the box where the field must be.
// `onBusy` gets true while an image goes to the server and false after it: the caller turns its send buttons off. Each image becomes a Markdown line in the text, and `thumbs` shows the images of the text.
export function attach(area, thumbs, onBusy = () => {}) {
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true });
  // A small picture icon at the right of the field. The style sheet draws it (.attach in common.css).
  const label = el('label', { className: 'attach', title: 'Attach an image. You can also paste an image or drop it on the field.' }, input);
  label.setAttribute('aria-label', 'Attach an image');
  // The field and the icon go into one box, so that the icon can be inside the field.
  const box = el('div', { className: 'field' });
  if (area.parentNode) area.replaceWith(box);
  box.append(area, label);
  const show = () => {
    thumbs.replaceChildren(...imageNames(area.value).map((name) => { const img = el('img', { alt: 'Attached image' }); img.dataset.image = name; return img; }));
    thumbs.hidden = !thumbs.children.length;
    loadImages(thumbs);
  };
  const add = async (files) => {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    label.classList.add('busy');
    onBusy(true);
    try {
      for (const file of images) {
        area.value = withImage(area.value, await uploadImage(file));
        area.dispatchEvent(new Event('input', { bubbles: true }));
      }
      note('');
    } catch (error) { note(error.message); } finally { label.classList.remove('busy'); onBusy(false); }
  };
  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  label.addEventListener('click', (event) => event.stopPropagation());
  area.addEventListener('input', show);
  area.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { event.preventDefault(); add(files); }
  });
  area.addEventListener('dragover', (event) => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
  area.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    add(event.dataTransfer.files);
  });
  show();
  return box;
}

// The colors of the page, for the frames of html blocks.
export function themeVars() {
  const style = getComputedStyle(document.documentElement);
  return ['--bg', '--panel', '--ink', '--dim', '--line', '--accent', '--warn'].map((name) => `${name}:${style.getPropertyValue(name).trim()}`).join(';');
}

// A frame reports its height (markdown.js). The page trusts only a number, from a frame that it made, in a safe range.
window.addEventListener('message', (event) => {
  const height = event.data?.memoFrameHeight;
  if (!Number.isFinite(height)) return;
  for (const frame of document.querySelectorAll('iframe.frame')) {
    if (frame.contentWindow === event.source) frame.style.height = `${Math.min(1500, Math.max(40, Math.ceil(height)))}px`;
  }
});
