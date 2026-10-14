// The lightbox: a memo image over the page, fit to the screen, with its alt text as the caption.
// It is a modal <dialog>: the browser keeps the focus in it, makes the page behind it inert, and closes it on Escape.
// It sets no touch-action, so pinch-zoom on a phone still works.

const SWIPE_PX = 50;

// The index after a step of -1 or +1 in a list of count images. The list goes round.
export function stepIndex(index, count, delta) {
  return (((index + delta) % count) + count) % count;
}

// The step of a one-finger swipe: +1 (next) for a move to the left, -1 (previous) for a move to the right,
// and 0 for a short move or a move that is mostly up or down.
export function swipeStep(dx, dy) {
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

// images: the loaded <img> elements of one memo. start: the index of the image that the reader opened.
// el: the element function of common.js. On close, the focus goes back to the image that the reader opened.
export function openLightbox(images, start, el) {
  const opener = images[start];
  let index = start;
  const many = images.length > 1;

  const picture = el('img', { className: 'lightbox-image' });
  const caption = el('figcaption', { className: 'lightbox-caption' });
  const count = el('span', { className: 'lightbox-count' });
  const original = el('a', { className: 'lightbox-original', target: '_blank', rel: 'noopener' }, 'Open original');
  const close = el('button', { type: 'button', className: 'lightbox-close', title: 'Close (Esc)' }, '×');
  close.setAttribute('aria-label', 'Close the image');
  const stepButton = (delta, label, text) => {
    const b = el('button', { type: 'button', className: `lightbox-step ${delta < 0 ? 'prev' : 'next'}`, title: label }, text);
    b.setAttribute('aria-label', label);
    b.addEventListener('click', (event) => { event.stopPropagation(); show(stepIndex(index, images.length, delta)); });
    return b;
  };
  const figure = el('figure', { className: 'lightbox-figure' }, picture, caption);
  const dialog = el('dialog', { className: 'lightbox' },
    el('div', { className: 'lightbox-bar' }, count, original, close),
    figure,
    ...(many ? [stepButton(-1, 'Previous image', '‹'), stepButton(1, 'Next image', '›')] : []));
  dialog.setAttribute('aria-label', 'Image');

  function show(i) {
    index = i;
    const img = images[i];
    picture.src = img.src;
    picture.alt = img.alt;
    caption.textContent = img.alt;
    caption.hidden = !img.alt;
    original.href = img.src;
    count.textContent = many ? `${i + 1} of ${images.length}` : '';
  }

  close.addEventListener('click', () => dialog.close());
  // A click on the dark area around the image closes the lightbox. A click on the image or the caption does not.
  dialog.addEventListener('click', (event) => { if (event.target === dialog || event.target === figure) dialog.close(); });
  dialog.addEventListener('keydown', (event) => {
    if (!many || event.target === original) return;
    if (event.key === 'ArrowRight') show(stepIndex(index, images.length, 1));
    else if (event.key === 'ArrowLeft') show(stepIndex(index, images.length, -1));
  });

  // A swipe with one finger goes to the next or the previous image. A pinch, or a move on a zoomed page, does not.
  let touch = null;
  dialog.addEventListener('touchstart', (event) => {
    const zoomed = window.visualViewport && window.visualViewport.scale > 1.01;
    touch = event.touches.length === 1 && !zoomed ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  }, { passive: true });
  dialog.addEventListener('touchmove', (event) => { if (event.touches.length > 1) touch = null; }, { passive: true });
  dialog.addEventListener('touchend', (event) => {
    if (!touch || !many || event.changedTouches.length !== 1) { touch = null; return; }
    const step = swipeStep(event.changedTouches[0].clientX - touch.x, event.changedTouches[0].clientY - touch.y);
    touch = null;
    if (step) show(stepIndex(index, images.length, step));
  });

  // Escape, the X, and the backdrop all end here.
  dialog.addEventListener('close', () => {
    dialog.remove();
    document.documentElement.classList.remove('lightbox-open');
    if (opener.isConnected) opener.focus();
  });

  show(start);
  document.body.append(dialog);
  document.documentElement.classList.add('lightbox-open');
  dialog.showModal();
  close.focus();
  return dialog;
}
