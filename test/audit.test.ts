import { describe, expect, it } from 'vitest';
import { maskSensitive } from '../src/domain/audit.js';

describe('maskSensitive', () => {
  it('masks sensitive keys at any depth and keeps everything else', () => {
    expect(
      maskSensitive({
        client: 'cl_acme',
        taxId: '12-3456789',
        bank: { accountNumber: '000123', name: 'First Bank' },
        rows: [{ iban: 'GB00X', amount: 10 }],
      }),
    ).toEqual({
      client: 'cl_acme',
      taxId: '***',
      bank: { accountNumber: '***', name: 'First Bank' },
      rows: [{ iban: '***', amount: 10 }],
    });
  });
});
