import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { OAuthMetadataSchema, type OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { mcpResourceUrl, type Config } from '../config.js';

/** Everything the HTTP layer needs to act as an OAuth protected resource. */
export type OAuthSetup = {
  /** The authorization server's metadata (from its discovery document). */
  metadata: OAuthMetadata;
  /** This server's resource identifier: the `/mcp` URL. */
  resourceUrl: URL;
  verifier: OAuthTokenVerifier;
  /** The provider's signing keys, also used to verify the dashboard's ID tokens. */
  keys: JWTVerifyGetKey;
};

/** Asymmetric algorithms only: `HS*` would let anyone holding the shared secret mint tokens. */
const ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];

const trimSlash = (value: string) => value.replace(/\/$/, '');

/** RFC 8414 first, then OpenID Connect discovery (both path styles), so Auth0 and WorkOS both work. */
function discoveryUrls(issuer: string): URL[] {
  const url = new URL(issuer);
  const path = trimSlash(url.pathname);
  const hrefs = new Set([
    new URL(`/.well-known/oauth-authorization-server${path}`, url.origin).href,
    new URL(`/.well-known/openid-configuration${path}`, url.origin).href,
    new URL(`${path}/.well-known/openid-configuration`, url.origin).href,
  ]);
  return [...hrefs].map((href) => new URL(href));
}

export async function discoverAuthorizationServer(issuer: string): Promise<OAuthMetadata> {
  for (const url of discoveryUrls(issuer)) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) continue;
    const metadata = OAuthMetadataSchema.parse(await res.json());
    if (trimSlash(metadata.issuer) !== trimSlash(issuer)) {
      throw new Error(`OAUTH_ISSUER is ${issuer} but its metadata names ${metadata.issuer}.`);
    }
    return metadata;
  }
  throw new Error(`No OAuth discovery document found for ${issuer}.`);
}

const stringClaim = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function scopesOf(payload: JWTPayload): string[] {
  if (typeof payload.scope === 'string') return payload.scope.split(' ').filter(Boolean);
  if (Array.isArray(payload.scp)) return payload.scp.filter((s): s is string => typeof s === 'string');
  return [];
}

function urlOrUndefined(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Verifies a JWT access token: signature (against the provider's JWKS), issuer, audience and expiry.
 * The user's email travels in `AuthInfo.extra.email`; `resolveActor()` maps it to a staff member.
 */
export function createJwtVerifier(options: {
  issuer: string;
  audience: string;
  emailClaim: string;
  keys: JWTVerifyGetKey;
}): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ALGORITHMS,
          requiredClaims: ['exp'],
          clockTolerance: 5,
        }));
      } catch (error) {
        // A bad token is the caller's problem (401, so the client signs in again);
        // an unreachable JWKS endpoint is ours (500, so it doesn't loop on sign-in).
        if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) {
          throw new InvalidTokenError('Invalid or expired access token');
        }
        throw new ServerError('Could not verify the access token');
      }
      return {
        token,
        clientId: stringClaim(payload.client_id) ?? stringClaim(payload.azp) ?? '',
        scopes: scopesOf(payload),
        expiresAt: payload.exp,
        resource: urlOrUndefined(options.audience),
        extra: { email: stringClaim(payload[options.emailClaim]), subject: payload.sub },
      };
    },
  };
}

const JwksUriSchema = z.object({ jwks_uri: z.url().optional() });

/** Reads the provider's discovery document and builds the token verifier. Called once at start-up. */
export async function setupOAuth(config: Config): Promise<OAuthSetup> {
  if (!config.oauth || !config.publicUrl) throw new Error('setupOAuth needs AUTH_MODE=oauth.');
  const metadata = await discoverAuthorizationServer(config.oauth.issuer);
  const jwksUrl = config.oauth.jwksUrl ?? JwksUriSchema.parse(metadata).jwks_uri;
  if (!jwksUrl) throw new Error('The issuer metadata has no jwks_uri. Set OAUTH_JWKS_URL.');
  const keys = createRemoteJWKSet(new URL(jwksUrl));
  const verifier = createJwtVerifier({
    // Tokens carry the issuer exactly as the provider publishes it (Auth0 adds a trailing slash).
    issuer: metadata.issuer,
    audience: config.oauth.audience,
    emailClaim: config.oauth.emailClaim,
    keys,
  });
  return { metadata, resourceUrl: mcpResourceUrl(config.publicUrl), verifier, keys };
}
