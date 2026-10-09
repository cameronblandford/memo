// Code that the two Memo pages share. All text goes into the page as text nodes, never as markup.
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
  node.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
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
