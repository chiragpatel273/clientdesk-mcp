import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived, signed links to a document's file, for citations Claude shows the user.
 * The link names the staff member it was issued to; the download route re-checks that person's access,
 * so a forwarded link still can't reach a client they aren't assigned to, and every download is audited.
 */
export interface LinkSigner {
  url(documentId: string, staffId: string, page?: number | null): string;
  verify(documentId: string, staffId: string, expires: number, signature: string): boolean;
}

export const LINK_TTL_SECONDS = 60 * 60;

export function createLinkSigner(secret: string, base: URL, now: () => number = Date.now): LinkSigner {
  const sign = (documentId: string, staffId: string, expires: number) =>
    createHmac('sha256', secret).update(`${documentId}\n${staffId}\n${expires}`).digest('base64url');
  return {
    url(documentId, staffId, page) {
      const expires = Math.floor(now() / 1000) + LINK_TTL_SECONDS;
      const url = new URL(`/files/${encodeURIComponent(documentId)}`, base);
      url.searchParams.set('u', staffId);
      url.searchParams.set('exp', String(expires));
      url.searchParams.set('sig', sign(documentId, staffId, expires));
      if (page) url.hash = `page=${page}`;
      return url.href;
    },
    verify(documentId, staffId, expires, signature) {
      if (!Number.isInteger(expires) || expires < Math.floor(now() / 1000)) return false;
      const expected = Buffer.from(sign(documentId, staffId, expires));
      const given = Buffer.from(signature);
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}
