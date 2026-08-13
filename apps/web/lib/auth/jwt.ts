import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import type { JWTPayload } from "jose";
import { env } from "@/lib/env";
import { CLI_TOKEN_KID, tokenKid, verifyCliToken } from "./cli-token";
import { detectGroupsOverage } from "./sync-groups";

/**
 * Authenticates a bearer token presented to the MCP endpoint. Two token
 * kinds are accepted, dispatched by the JWT `kid` header:
 *
 *   - IdP-issued OIDC access tokens (any kid) — verified against the
 *     issuer's JWKS over the network, located via OIDC discovery.
 *   - CLI tokens minted at /connect (kid="cli-v1") — verified locally
 *     with the HMAC CLI_TOKEN_SECRET.
 *
 * Both resolve to the same `AuthenticatedClaims` shape so downstream code
 * (`userContextFromClaims`) doesn't care which path produced them.
 *
 * This is distinct from the NextAuth session cookie path used by the Web UI.
 */

type JwkSet = ReturnType<typeof createRemoteJWKSet>;

type GlobalWithJwks = typeof globalThis & {
  /**
   * Resolved key set, cached as a *promise* rather than a value.
   *
   * Resolution now involves a network round-trip (OIDC discovery), and the
   * MCP endpoint verifies a token on essentially every request. Caching the
   * settled value would leave a window in which N concurrent cold requests
   * each start their own discovery fetch; caching the in-flight promise means
   * the first caller does the work and everyone else awaits the same result.
   */
  __sharedMemoryJwks?: Promise<JwkSet>;
  /**
   * Epoch ms after which discovery should be re-attempted, set only when we
   * had to fall back (see `jwks()`). Undefined means the cached set came from
   * a successful discovery and is good indefinitely.
   */
  __sharedMemoryJwksRetryAt?: number;
};
const g = globalThis as GlobalWithJwks;

/**
 * Issuer of MCP access tokens. The MCP endpoint is a separate application in
 * the IdP from the Web UI, and Authentik stamps each token with its own
 * application slug, so this is NOT interchangeable with OIDC_ISSUER.
 *
 * Not every IdP works that way: EntraID has one issuer per tenant regardless
 * of how many app registrations you create, so OIDC_ISSUER_MCP is left unset
 * there and this falls through to OIDC_ISSUER.
 */
export function mcpIssuer(): string {
  return env().OIDC_ISSUER_MCP ?? env().OIDC_ISSUER;
}

/**
 * Issuer values accepted for the `iss` claim.
 *
 * jose compares `iss` by exact string, and IdPs are inconsistent about the
 * trailing slash: Authentik emits `.../application/o/<slug>/` while the same
 * value is routinely configured without it. Normalizing to one form and
 * comparing against that fails whenever the two disagree — which is exactly
 * how this broke: the URL-safe (stripped) form was reused for the claim check
 * against a token whose `iss` ended in a slash.
 *
 * Accept both spellings rather than making correctness depend on how someone
 * typed an env var.
 */
function acceptedIssuers(): [string, string] {
  const bare = mcpIssuer().replace(/\/$/, "");
  return [bare, `${bare}/`];
}

const JWKS_OPTIONS = {
  cacheMaxAge: 10 * 60 * 1000, // 10 min
  cooldownDuration: 30 * 1000,
} as const;

/** How long to keep serving a fallback key set before retrying discovery. */
const DISCOVERY_RETRY_COOLDOWN_MS = 60 * 1000;

/** Discovery can hang; every MCP request waits on it, so bound it. */
const DISCOVERY_TIMEOUT_MS = 5 * 1000;

/**
 * The pre-discovery convention: `${issuer}/jwks/`.
 *
 * This is Authentik's canonical JWKS path and was hardcoded here. It stays as
 * the fallback so that a deployment whose discovery document is unreachable
 * behaves exactly as it did before this change.
 */
function fallbackJwksUri(): string {
  return `${mcpIssuer().replace(/\/$/, "")}/jwks/`;
}

/**
 * Read `jwks_uri` out of the MCP issuer's OIDC discovery document.
 *
 * `${issuer}/jwks/` is an Authentik convention, not a standard — RFC 8414
 * says the key set lives wherever `jwks_uri` points, and providers disagree
 * wildly. EntraID serves keys at
 * `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`, nowhere
 * near `${issuer}/jwks/`, so with the path hardcoded every EntraID-issued MCP
 * token fails verification with a 404 on the key set — authentication is
 * simply impossible, not merely misconfigured. Ask the issuer where its keys
 * are instead of guessing.
 *
 * Returns null (never throws) on any failure, so the caller can fall back.
 */
async function discoverJwksUri(): Promise<string | null> {
  const url = `${mcpIssuer().replace(/\/$/, "")}/.well-known/openid-configuration`;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const doc: unknown = await res.json();
    const uri = (doc as { jwks_uri?: unknown } | null)?.jwks_uri;
    if (typeof uri !== "string" || uri.trim().length === 0) return null;
    // A malformed jwks_uri must not blow up the request path.
    new URL(uri);
    return uri;
  } catch {
    return null;
  }
}

/**
 * The key set MCP access tokens are verified against, resolved once per
 * process.
 *
 * Async because discovery is a network call. The cached promise is installed
 * synchronously — before the first `await` inside the IIFE runs — so
 * concurrent callers always join the existing resolution rather than racing
 * to start their own.
 *
 * When discovery fails we serve the legacy fallback but arm a retry: a single
 * blip at process start would otherwise pin the wrong URL for the lifetime of
 * the container, which on EntraID means MCP auth stays broken until someone
 * restarts it. The cooldown keeps a persistently-unreachable discovery
 * endpoint from being hit on every request.
 */
function jwks(): Promise<JwkSet> {
  const retryAt = g.__sharedMemoryJwksRetryAt;
  const dueForRetry = retryAt !== undefined && Date.now() >= retryAt;
  if (g.__sharedMemoryJwks && !dueForRetry) return g.__sharedMemoryJwks;

  g.__sharedMemoryJwksRetryAt = undefined;
  g.__sharedMemoryJwks = (async () => {
    const discovered = await discoverJwksUri();
    if (discovered) return createRemoteJWKSet(new URL(discovered), JWKS_OPTIONS);
    g.__sharedMemoryJwksRetryAt = Date.now() + DISCOVERY_RETRY_COOLDOWN_MS;
    return createRemoteJWKSet(new URL(fallbackJwksUri()), JWKS_OPTIONS);
  })();
  return g.__sharedMemoryJwks;
}

export interface AuthenticatedClaims extends JWTPayload {
  sub: string;
  iss: string;
  /**
   * Group names from the OIDC `groups` claim. Authentik / Keycloak / properly-
   * configured EntraID emit `string[]` here. We coerce non-array / non-string
   * entries away and present an empty array if the claim is absent. For CLI
   * (HMAC) tokens this is always undefined — the consumer (userContextFromClaims)
   * falls back to the DB snapshot from the user's last interactive sign-in.
   */
  groups?: string[];
}

export class UnauthorizedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly wwwAuthenticate: string,
  ) {
    super(reason);
    this.name = "UnauthorizedError";
  }
}

/**
 * Pull `groups` off a verified OIDC payload as a clean `string[]`. Non-
 * string entries are dropped silently. Returns undefined when the claim
 * is absent so callers can distinguish "no claim emitted" from "user is
 * in zero groups" (`[]`).
 */
function extractGroupsClaim(payload: JWTPayload): string[] | undefined {
  const raw = (payload as { groups?: unknown }).groups;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim().length > 0) out.push(v.trim());
  }
  return out;
}

function buildWwwAuthenticate(error?: string, description?: string): string {
  const parts: string[] = [`Bearer realm="OAuth"`];
  // RFC 9728 — point clients at our protected-resource metadata so they can
  // discover the authorization server.
  parts.push(`resource_metadata="${env().PUBLIC_URL.replace(/\/$/, "")}/.well-known/oauth-protected-resource"`);
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(", ");
}

export async function authenticateBearer(authHeader: string | null): Promise<AuthenticatedClaims> {
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    throw new UnauthorizedError("missing bearer token", buildWwwAuthenticate());
  }

  const token = authHeader.slice("bearer ".length).trim();
  if (!token) {
    throw new UnauthorizedError("empty bearer token", buildWwwAuthenticate("invalid_token"));
  }

  // Dispatch by kid: CLI tokens are verified locally, everything else goes
  // through Authentik JWKS. We never attempt JWKS verification for CLI
  // tokens (or vice versa) so a kid mismatch fails fast.
  const isCliToken = tokenKid(token) === CLI_TOKEN_KID;

  try {
    if (isCliToken) {
      const claims = await verifyCliToken(token);
      // CLI tokens carry the user's real Authentik identity in oidc_iss /
      // oidc_sub. Surface those on the standard claims shape so user
      // context resolution is identical to the Authentik path. CLI tokens
      // never carry a groups claim — leave `groups` undefined; the user-
      // context resolver falls back to the DB snapshot.
      return {
        ...claims,
        iss: claims.oidc_iss,
        sub: claims.oidc_sub,
      } as AuthenticatedClaims;
    }

    const { payload } = await jwtVerify(token, await jwks(), {
      issuer: acceptedIssuers(),
      audience: env().OIDC_AUDIENCE,
    });
    if (!payload.sub) {
      throw new UnauthorizedError(
        "token missing sub claim",
        buildWwwAuthenticate("invalid_token", "missing sub"),
      );
    }
    // Groups overage: the IdP is telling us it holds memberships it declined
    // to list. `extractGroupsClaim` would read that as "no claim emitted" and
    // userContextFromClaims would fall back to the DB snapshot — granting
    // project access from a stale record while the live state is admittedly
    // unknown. Refuse; the operator fix is in the description.
    if (detectGroupsOverage(payload)) {
      const desc =
        "groups overage: IdP did not enumerate group membership " +
        "(set groupMembershipClaims=ApplicationGroup on EntraID)";
      throw new UnauthorizedError(desc, buildWwwAuthenticate("invalid_token", desc));
    }
    // Normalize the issuer for identity purposes.
    //
    // The token was just verified against mcpIssuer() — that check is done.
    // But identity is keyed on (oidc_iss, oidc_sub), and the Web UI signs
    // people in through a DIFFERENT application whose tokens carry
    // OIDC_ISSUER. Authentik's `sub` is stable across providers (it is
    // `user.uid`, a user-level value), so the only thing that differs is the
    // issuer.
    //
    // Leave it un-normalized and userContextFromClaims — which UPSERTS rather
    // than failing — quietly creates a SECOND user row for the same human:
    // MCP writes would land in an account with none of their memories, and
    // nothing would look broken. Pin identity to the canonical issuer.
    return {
      ...payload,
      iss: env().OIDC_ISSUER,
      groups: extractGroupsClaim(payload),
    } as AuthenticatedClaims;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    const desc =
      err instanceof joseErrors.JWTExpired
        ? "token expired"
        : err instanceof joseErrors.JWTInvalid
        ? "token invalid"
        : err instanceof joseErrors.JWTClaimValidationFailed
        ? `claim invalid: ${err.claim}`
        : "verification failed";
    throw new UnauthorizedError(desc, buildWwwAuthenticate("invalid_token", desc));
  }
}
