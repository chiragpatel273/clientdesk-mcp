/**
 * `npm run workos:users`: creates the three demo staff (Maya, Tom, Ana) in your WorkOS environment so they can sign
 * in to the Claude connector. Run it once, in your own terminal; it prints each new user's password once.
 *
 * WorkOS always asks new users to verify their email, and the fictional @northbridge.example addresses can't receive
 * mail, so the users are created as already verified (an admin-only API option). Users that already exist are skipped.
 *
 * Needs WORKOS_API_KEY (your environment's secret key, sk_test_...) in .env. The server itself never uses it.
 */
import { randomBytes } from 'node:crypto';
import { loadDotEnv } from '../src/config.js';
import { STAFF } from '../src/demo/firm.js';

loadDotEnv();
const apiKey = process.env.WORKOS_API_KEY;
if (!apiKey) {
  console.error('Set WORKOS_API_KEY in .env first (WorkOS dashboard > API Keys > Secret key).');
  process.exit(1);
}

const api = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`https://api.workos.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`WorkOS ${res.status}: ${String(body.message ?? body.error ?? res.statusText)}`);
  return body;
};

// Long and mixed, to pass any password strength policy.
const newPassword = () => `Nb-${randomBytes(12).toString('base64url')}-7a`;

const created: { email: string; password: string }[] = [];
for (const staff of STAFF) {
  const existing = (await api(`/user_management/users?email=${encodeURIComponent(staff.email)}`)) as {
    data?: unknown[];
  };
  if (existing.data?.length) {
    console.log(`exists   ${staff.email}`);
    continue;
  }
  const [firstName, ...rest] = staff.name.split(' ');
  const password = newPassword();
  await api('/user_management/users', {
    method: 'POST',
    body: JSON.stringify({
      email: staff.email,
      first_name: firstName,
      last_name: rest.join(' '),
      password,
      email_verified: true,
    }),
  });
  created.push({ email: staff.email, password });
  console.log(`created  ${staff.email}`);
}

if (created.length) {
  console.log('\nSave these now; they are not shown again:\n');
  for (const { email, password } of created) console.log(`  ${email.padEnd(28)} ${password}`);
} else {
  console.log('\nNothing to do. To reset a password, use the WorkOS dashboard (Users > the user > Reset password).');
}
