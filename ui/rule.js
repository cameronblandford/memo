// A permission rule that an agent asks for (memo rule). The memo text has a part for the owner and, as its last
// line, a marker for the server: <!-- memo-rule: {"agent":"main","rule":"Bash(npm test:*)"} -->
// The Inbox hides the marker line and shows the rule of the marker with the Approve button. The server writes the
// rule only when the owner approves it (see src/rules.js). This file has no DOM code, so the server and a test can import it.

export const MAX_RULE = 300;
const MARKER = /^<!-- memo-rule: (\{.*\}) -->$/;
const isMarker = (line) => line.startsWith('<!-- memo-rule:');
// The form of a Claude Code permission rule: a tool name, with an optional pattern in parentheses.
const FORM = /^[A-Za-z][A-Za-z0-9_-]*(\(.+\))?$/;

// A problem with the form of the rule, or '' for a rule with a good form.
export function ruleProblem(rule) {
  if (typeof rule !== 'string' || !rule) return 'The rule is necessary.';
  if (rule.length > MAX_RULE) return `A rule must have ${MAX_RULE} characters or fewer.`;
  if (/[\u0000-\u001f\u007f]/.test(rule)) return 'A rule must be one line, with no control characters.';
  if (rule !== rule.trim()) return 'A rule must not start or end with a space.';
  if (!FORM.test(rule)) return 'A rule must be a tool name, for example WebSearch, or a tool name with a pattern, for example Bash(npm test:*).';
  return '';
}

// The marker line. < > and & go as \u escapes, so a rule with "-->" cannot end the comment.
export function ruleMarker(agent, rule) {
  const json = JSON.stringify({ agent, rule }).replace(/[<>&]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<!-- memo-rule: ${json} -->`;
}

// The full memo text of memo rule.
export function ruleText({ agent, rule, why }) {
  return `**${agent} asks for a Claude Code permission rule.** ${why}\n\n`
    + `The rule for the settings file of ${agent}:\n\n\`\`\`\n${rule}\n\`\`\`\n\n`
    + `Approve rule adds it to permissions.allow, and ${agent} gets the result. Reply or Close refuses it.\n\n`
    + ruleMarker(agent, rule);
}

// { agent, rule } from the marker, or null. The marker must be the last line, and the text must have only one.
export function parseRule(text) {
  const lines = String(text ?? '').trimEnd().split('\n');
  if (lines.filter(isMarker).length !== 1) return null;
  const m = lines.at(-1).match(MARKER);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  if (!data || typeof data.agent !== 'string' || typeof data.rule !== 'string' || !data.agent || !data.rule) return null;
  return { agent: data.agent, rule: data.rule };
}

// The text with no marker line, for the Inbox.
export const withoutMarker = (text) => String(text ?? '').split('\n').filter((line) => !isMarker(line)).join('\n').trimEnd();
