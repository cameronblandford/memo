import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The files of one installation (the agent list and the charters) are in local/, which git ignores.
// A file that is not there comes from the examples in the repository. MEMO_LOCAL gives a different directory.
export function localFile(root, ...parts) {
  const own = join(process.env.MEMO_LOCAL || join(root, 'local'), ...parts);
  return existsSync(own) ? own : join(root, ...parts);
}
