/**
 * Test environment. `lib/env.ts` validates a full production config at
 * import time, so integration tests that touch the DB need these set
 * before any module under test is loaded.
 *
 * Only DATABASE_URL points at anything real — a throwaway Postgres with
 * pgvector. The OIDC/secret values exist purely to satisfy validation;
 * tests construct a UserContext directly rather than going through auth.
 */
// NODE_ENV is set to "test" by vitest itself.
//
// DATABASE_URL points at a throwaway pgvector instance. The default assumes
// the published port is reachable on localhost; when the test runner is
// itself inside a container, export DATABASE_URL with the database
// container's address instead. See README → Running the tests.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:55432/shared_memory_test";
process.env.PUBLIC_URL ??= "http://localhost:3000";
process.env.OIDC_ISSUER ??= "http://localhost:9000/application/o/test/";
process.env.OIDC_CLIENT_ID_WEB ??= "test-web";
process.env.OIDC_CLIENT_SECRET_WEB ??= "test-web-secret";
process.env.OIDC_CLIENT_ID_MCP ??= "test-mcp";
process.env.OIDC_AUDIENCE ??= "test-audience";
process.env.EMBEDDER_URL ??= "http://localhost:8080";
process.env.NEXTAUTH_SECRET ??= "test-nextauth-secret-at-least-32-chars-long";
process.env.CLI_TOKEN_SECRET ??= "test-cli-token-secret-at-least-32-chars-long";
