// Stop hook: before Claude finishes a turn, the code must typecheck and lint.
// Exit code 2 sends the errors back to Claude so it fixes them instead of stopping.
import { spawnSync } from 'node:child_process';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  // no payload: run the checks anyway
}

// Already continuing because of this hook: don't loop forever.
if (payload.stop_hook_active) process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
for (const script of ['typecheck', 'lint']) {
  const result = spawnSync('npm', ['run', '-s', script], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(0, 40).join('\n');
    process.stderr.write(`npm run ${script} failed. Fix these before finishing:\n${output}\n`);
    process.exit(2);
  }
}
process.exit(0);
