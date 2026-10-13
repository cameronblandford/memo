// The Enter key in the capture field. This file has no DOM code, so a test can import it.

// True if this key event sends the memo. Shift+Enter adds a line. On a touch screen the keyboard
// has no Shift+Enter, so Enter adds a line there and the Send button sends.
// An Enter that confirms the text of an input method does not send: in Safari that event comes after the
// composition ends, with isComposing false and the key code 229. A key that repeats while it is held does not send.
export function enterSends(event, touch) {
  if (event.isComposing || event.keyCode === 229 || event.repeat) return false;
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !touch;
}

// The height of a field that grows with its text, in pixels: not more than `max`.
export function fieldHeight(scrollHeight, max) {
  return Math.min(Math.max(0, Math.ceil(scrollHeight)), max);
}
