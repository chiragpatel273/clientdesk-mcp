// PostToolUse hook: formats the file Claude just edited with Prettier.
// Reads the hook payload from stdin; never blocks Claude (always exits 0).
import { execFileSync } from 'node:child_process';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const payload = JSON.parse(raw);
  const file = payload?.tool_input?.file_path;
  if (typeof file === 'string' && /\.(ts|mjs|js|json|md|sql)$/.test(file) && !file.includes('node_modules')) {
    execFileSync('npx', ['--no-install', 'prettier', '--write', '--log-level', 'silent', file], {
      cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
  }
} catch {
  // Formatting is a convenience; a failure here should never interrupt work.
}
process.exit(0);
