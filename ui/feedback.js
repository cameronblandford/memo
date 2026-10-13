// The signs on a button while a memo goes out. This file has no DOM code of its own: it sets only
// `disabled` and class names on the button that it gets, so a test can import it.

export const SENT_MS = 900; // how long the check mark shows

// Runs `action` with the button off and the class `sending` (the style sheet draws a spinner). After
// the action, the class `sent` shows a check mark for a short time. If the action fails, the button
// goes back at once and the error goes to the caller. Gives false, with no action, for a button that
// is off: a second tap must not send the text again.
// With no button (a caller that has none), the action runs with no signs.
export async function withFeedback(button, action, { wait = (ms) => new Promise((done) => setTimeout(done, ms)), hold = SENT_MS } = {}) {
  if (!button) { await action(); return true; }
  if (button.disabled) return false;
  button.disabled = true;
  button.classList.add('sending');
  try {
    await action();
  } catch (error) {
    button.classList.remove('sending');
    button.disabled = false;
    throw error;
  }
  button.classList.remove('sending');
  button.classList.add('sent');
  await wait(hold);
  button.classList.remove('sent');
  button.disabled = false;
  return true;
}
