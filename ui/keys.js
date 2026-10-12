// The Enter key in the capture field. This file has no DOM code, so a test can import it.

// True if this key event sends the memo. Shift+Enter adds a line. On a touch screen the keyboard
// has no Shift+Enter, so Enter adds a line there and the Send button sends.
export function enterSends(event, touch) {
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing && !touch;
}

// The height of a field that grows with its text, in pixels: not more than `max`.
export function fieldHeight(scrollHeight, max) {
  return Math.min(Math.max(0, Math.ceil(scrollHeight)), max);
}
