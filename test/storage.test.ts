import { describe, expect, it } from 'vitest';
import { loadConfig, type S3Config } from '../src/config.js';
import { s3FileStore } from '../src/storage/files.js';

const aws: S3Config = {
  provider: 'S3',
  bucket: 'clientdesk-documents',
  region: 'us-west-2',
  endpoint: undefined,
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
};

/** Records each signed request and answers with the given status (and the uploaded bytes on GET). */
function fakeBucket(status = 200) {
  const requests: Request[] = [];
  const stored = new Map<string, Uint8Array>();
  const doFetch = (async (input: Request) => {
    requests.push(input);
    if (status !== 200) return new Response(null, { status });
    if (input.method === 'PUT') stored.set(input.url, new Uint8Array(await input.arrayBuffer()));
    return new Response(input.method === 'GET' ? (stored.get(input.url) ?? null) : null, { status: 200 });
  }) as typeof fetch;
  return { doFetch, requests };
}

describe('S3 file store', () => {
  it('signs requests to the regional AWS bucket address', async () => {
    const bucket = fakeBucket();
    const store = s3FileStore(aws, bucket.doFetch);
    await store.put('documents/doc_1/abc', new Uint8Array([1, 2, 3]), 'application/pdf');
    expect(await store.get('documents/doc_1/abc')).toEqual(new Uint8Array([1, 2, 3]));
    const [put] = bucket.requests;
    expect(put!.url).toBe('https://clientdesk-documents.s3.us-west-2.amazonaws.com/documents/doc_1/abc');
    expect(put!.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/s3\//,
    );
  });

  it('uses path-style addresses for other S3-compatible services', async () => {
    const bucket = fakeBucket();
    const store = s3FileStore(
      { ...aws, endpoint: 'https://acct.r2.cloudflarestorage.com/', region: 'auto' },
      bucket.doFetch,
    );
    await store.put('documents/doc_1/abc', new Uint8Array([1]), 'application/pdf');
    expect(bucket.requests[0]!.url).toBe(
      'https://acct.r2.cloudflarestorage.com/clientdesk-documents/documents/doc_1/abc',
    );
  });

  it('returns null for a missing file and names the provider on errors', async () => {
    expect(await s3FileStore(aws, fakeBucket(404).doFetch).get('documents/x')).toBeNull();
    await expect(s3FileStore(aws, fakeBucket(403).doFetch).get('documents/x')).rejects.toThrow(
      'S3 download failed (403)',
    );
  });

  it('says which region the bucket is really in', async () => {
    const xml = '<Error><Code>PermanentRedirect</Code></Error>';
    const doFetch = (async () =>
      new Response(xml, { status: 301, headers: { 'x-amz-bucket-region': 'ap-south-1' } })) as unknown as typeof fetch;
    await expect(s3FileStore(aws, doFetch).put('documents/x', new Uint8Array([1]), 'text/plain')).rejects.toThrow(
      'S3 upload failed (301 PermanentRedirect); the bucket is in ap-south-1',
    );
  });

  it('refuses unsafe keys before sending anything', async () => {
    const bucket = fakeBucket();
    await expect(s3FileStore(aws, bucket.doFetch).get('../other-bucket/x')).rejects.toThrow('Invalid storage key');
    expect(bucket.requests).toHaveLength(0);
  });
});

describe('storage config', () => {
  const base = { NODE_ENV: 'test', AUTH_MODE: 'dev' } as const;

  it('reads Amazon S3 settings and says which are missing', () => {
    expect(() => loadConfig({ ...base, STORAGE: 's3', S3_BUCKET: 'b' })).toThrow(
      'STORAGE=s3 requires S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.',
    );
    const config = loadConfig({
      ...base,
      STORAGE: 's3',
      S3_BUCKET: 'b',
      S3_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'k',
      AWS_SECRET_ACCESS_KEY: 's',
    });
    expect(config.storage).toMatchObject({ kind: 's3', provider: 'S3', endpoint: undefined, region: 'us-west-2' });
  });

  it('keeps R2 working as an S3-compatible endpoint', () => {
    const config = loadConfig({
      ...base,
      STORAGE: 'r2',
      R2_ACCOUNT_ID: 'acct',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_BUCKET: 'b',
    });
    expect(config.storage).toMatchObject({
      kind: 's3',
      provider: 'R2',
      region: 'auto',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
    });
  });
});
