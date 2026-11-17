/**
 * `npm run storage:check`: writes a small test file to the configured bucket and reads it back, so storage keys can
 * be checked from a laptop before deploying. Leave STORAGE=local in .env and run it as
 *
 *   STORAGE=s3 npm run storage:check
 *
 * with S3_BUCKET, S3_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env (variables set on the command line win).
 */
import { loadConfig, loadDotEnv } from '../src/config.js';
import { createFileStore } from '../src/storage/files.js';

loadDotEnv();
const config = loadConfig();
if (config.storage.kind !== 's3') {
  console.error('Storage is local. Run: STORAGE=s3 npm run storage:check (or STORAGE=r2).');
  process.exit(1);
}
const { provider, bucket, region } = config.storage;
const store = createFileStore(config);
const key = 'healthcheck/storage-check.txt';
const text = `ClientDesk storage check ${new Date().toISOString()}`;

const hints: Record<string, string> = {
  InvalidAccessKeyId: 'AWS does not know this access key: check AWS_ACCESS_KEY_ID.',
  SignatureDoesNotMatch: 'The secret does not match the key: check AWS_SECRET_ACCESS_KEY.',
  AccessDenied: "The key works but may not use this bucket: check the IAM policy's bucket name.",
  NoSuchBucket: 'No bucket with that name: check S3_BUCKET.',
  InvalidBucketName: 'That is not a valid bucket name: check S3_BUCKET.',
  PermanentRedirect: 'The bucket is in a different region: check S3_REGION.',
  AuthorizationHeaderMalformed: 'The bucket is in a different region: check S3_REGION.',
};

try {
  await store.put(key, new TextEncoder().encode(text), 'text/plain');
  const back = await store.get(key);
  if (!back || new TextDecoder().decode(back) !== text) throw new Error('read back different content');
  console.log(`OK: wrote and read back a test file in ${provider} bucket "${bucket}" (${region}).`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/\(\d{3} (\w+)\)/)?.[1];
  console.error(`Failed: ${message}`);
  if (code && hints[code]) console.error(hints[code]);
  process.exit(1);
}
