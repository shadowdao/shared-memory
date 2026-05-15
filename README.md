# shared-memory

A self-hosted MCP server that gives Claude Code sessions a **shared, persistent
memory** plus a **reusable snippet library**, behind your own Authentik OIDC
login. Includes a Web UI for reviewing, editing, and deleting what's been
stored.

> **Status:** Phase 1 — core memory path end-to-end (write / list / get /
> delete), Authentik-authed Web UI, MCP endpoint with Authentik JWT validation.
> Semantic search and the rich Web UI land in Phase 2 / Phase 3.

---

## Architecture

```
┌─────────────────┐        ┌───────────────────────┐        ┌──────────────┐
│  Claude Code    │──MCP──▶│  shared-memory app    │◀──OIDC─│   Authentik  │
│  (many sessions)│  HTTP  │  Next.js + MCP route  │        └──────────────┘
└─────────────────┘        │  + Web UI             │              ▲
                           └───────────┬───────────┘              │
                                       │                          │
                                ┌──────▼──────┐         user logs in
                                │ Postgres 16 │         via web browser
                                │  + pgvector │
                                └─────────────┘
```

The same container serves both the MCP endpoint (under `/api/mcp`) and the
Web UI. Users authenticate via your Authentik instance — pre-registered
confidential clients, not dynamic client registration. Identity is keyed on
the OIDC `sub` claim so memories are scoped per user.

---

## Prerequisites

- A host with **Docker** and **Docker Compose v2** installed.
- A **self-hosted Authentik instance** you administer.
- A **public DNS record** for the chosen hostname pointing at your reverse
  proxy (HAProxy, nginx, Cloudflare Tunnel, …) or at this host directly.
- A Postgres-friendly disk for the `db_data` volume.

---

## Deployment modes

Pick one based on how you handle TLS:

### Mode A — Behind an external reverse proxy (DEFAULT)

You already have HAProxy / nginx / Traefik / Cloudflare Tunnel terminating
TLS for your domain. The app exposes a plain HTTP port to the host; your
proxy forwards traffic to it.

```bash
docker compose up -d
```

The app listens on `${APP_PORT:-3000}` on the host. Point your proxy there.
See **HAProxy example** below.

### Mode B — Built-in TLS via Caddy

The host directly faces the internet on ports 80/443 and you want
auto-managed Let's Encrypt certs.

```bash
docker compose --profile tls up -d
```

Caddy reads `APP_HOSTNAME` and `ACME_EMAIL` from `.env` and proxies to the
app on the internal Docker network.

---

## Quick start

```bash
git clone https://repo.anhonesthost.net/jknapp/shared-memory.git
cd shared-memory
cp .env.example .env
# edit .env — see "Configuration" and "Authentik setup" below
docker compose build
docker compose up -d                # Mode A (behind external proxy)
# OR
docker compose --profile tls up -d  # Mode B (built-in TLS)

# tail logs to watch migrations run + app come up
docker compose logs -f migrator app
```

When `app` reports `Listening on http://0.0.0.0:3000`, visit your
`PUBLIC_URL` and click **Sign in with Authentik**. You should land on
`/me` showing your OIDC session.

---

## Configuration

All runtime config is in `.env` at the repo root. Never commit this file.
Copy `.env.example` and fill in the values below.

| Variable | Mode | What it is |
|---|---|---|
| `PUBLIC_URL` | both | Full external URL of this app, e.g. `https://memory.dnspegasus.net`. Used by Auth.js for callbacks and by the MCP route for resource metadata. |
| `APP_PORT` | A | Host port the app listens on for the external proxy. Default `3000`. |
| `APP_BIND` | A | Interface to bind on. Use `127.0.0.1` to only accept traffic from a proxy on the same host. Default `0.0.0.0`. |
| `APP_HOSTNAME` | B | Hostname only (no scheme). Caddy uses it for the TLS site block. |
| `ACME_EMAIL` | B | Email for Let's Encrypt registration. |
| `OIDC_ISSUER` | both | Authentik's OIDC issuer URL for **this app**. Looks like `https://auth.example.com/application/o/shared-memory/`. |
| `OIDC_CLIENT_ID_WEB` | both | Client ID of the Web-UI Authentik provider. |
| `OIDC_CLIENT_SECRET_WEB` | both | Client secret of the Web-UI Authentik provider. |
| `OIDC_CLIENT_ID_MCP` | both | Client ID of the MCP resource-server Authentik provider. |
| `OIDC_AUDIENCE` | both | Audience string the MCP access token must carry in its `aud` claim. Recommended: `shared-memory`. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | both | Local Postgres credentials. |
| `NEXTAUTH_SECRET` | both | Session-cookie signing key. Generate with `openssl rand -base64 32`. |
| `EMBEDDER_URL` | both | Phase 2 embedder sidecar. Leave empty in Phase 1. |
| `LOG_LEVEL` | both | `debug` / `info` / `warn` / `error`. |

Mode column: **A** = external proxy (default), **B** = built-in Caddy TLS.

---

## Authentik setup

You need **two** Authentik OAuth2/OpenID Connect providers + applications:
one for the Web UI (browser logins), one for the MCP resource server (the
audience Claude Code's access tokens are minted for). Reusing one provider
for both works, but the dual-provider setup keeps audiences cleanly separated
and is what the rest of this doc assumes.

### A. Web UI provider

**Admin → Applications → Providers → Create → OAuth2/OpenID Provider**

- **Name:** `shared-memory-web`
- **Authorization flow:** `default-provider-authorization-explicit-consent`
  (or your standard auth flow)
- **Client type:** `Confidential`
- **Client ID:** auto-generated → copy to `.env` as `OIDC_CLIENT_ID_WEB`
- **Client Secret:** auto-generated → copy to `.env` as `OIDC_CLIENT_SECRET_WEB`
- **Redirect URIs / Origins:**
  ```
  https://memory.dnspegasus.net/api/auth/callback/authentik
  ```
  (replace with your `PUBLIC_URL`)
- **Signing Key:** select your `authentik Self-signed Certificate`
- **Scopes:** `openid`, `profile`, `email`

Save. Then **Admin → Applications → Applications → Create**:

- **Name / Slug:** `shared-memory` (the slug becomes the path in the issuer URL)
- **Provider:** `shared-memory-web`
- **Launch URL:** `https://memory.dnspegasus.net/`

The slug is what makes `OIDC_ISSUER` end with `.../application/o/shared-memory/`.

### B. MCP resource-server provider

The MCP endpoint validates **access tokens** issued by Authentik for a specific
audience (`OIDC_AUDIENCE`). This second provider exists so Claude Code's
tokens carry `aud: shared-memory` (or whatever value you chose).

**Admin → Applications → Providers → Create → OAuth2/OpenID Provider**

- **Name:** `shared-memory-mcp`
- **Authorization flow:** same as above
- **Client type:** `Public` (Claude Code runs PKCE without a static secret)
  or `Confidential` if you prefer to issue a secret to each Claude Code
  install — both work. Phase 1 expects Public.
- **Client ID:** auto-generated → copy to `.env` as `OIDC_CLIENT_ID_MCP`
- **Redirect URIs:** Claude Code prints the exact value when it first
  connects to the MCP endpoint. Paste it into Authentik then.
- **Scopes:** `openid`, `profile`, `email`
- **Signing Key:** same cert as the Web provider

#### Setting the `aud` claim

The MCP endpoint requires the access token's `aud` claim to equal
`OIDC_AUDIENCE`. Authentik does not always emit `aud` by default. The
reliable pattern:

1. Create a **scope mapping** (Customisation → Property Mappings → Create →
   Scope Mapping) named `aud-shared-memory` with expression:
   ```python
   return {"aud": "shared-memory"}
   ```
2. On the MCP provider, add this scope mapping under **Scopes** and tick it
   so it's emitted for the default scope.

> If you skip this, the MCP route will return 401 with
> `error_description="claim invalid: aud"`. Check `docker compose logs app`
> for the exact failure.

Then create an **Application** for the MCP provider (same as Step A), slug
e.g. `shared-memory-mcp`.

### C. Assign users

For each Authentik user who should have access, add them to the bound group
on both applications (or set the applications' authentication policy to
permit them). Anyone not granted access will fail at the Authentik login
prompt, never reaching the app.

---

## Connecting Claude Code

In a future Phase, we'll publish a one-line Claude Code config snippet. For
Phase 1, follow the [MCP authorization flow][mcp-auth]:

1. Add the MCP server to Claude Code's config, pointing at
   `https://memory.dnspegasus.net/api/mcp`.
2. On first connection, the server returns 401 with `WWW-Authenticate`
   pointing at `/.well-known/oauth-protected-resource`.
3. Claude Code reads the protected-resource metadata, follows the link to
   Authentik's discovery doc, and runs the OAuth 2.1 PKCE flow.
4. You'll be prompted in your browser to authenticate with Authentik.
5. Claude Code stores the access token and uses it on subsequent requests.

If Authentik refuses the redirect URI Claude Code attempts to use, copy the
URI from the error and add it under the MCP provider's **Redirect URIs**.

[mcp-auth]: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

---

## HAProxy example

If you run HAProxy at the edge (TLS terminator + reverse proxy), a minimal
config for this app looks like:

```haproxy
frontend https_in
    bind *:443 ssl crt /etc/haproxy/certs/memory.dnspegasus.net.pem alpn h2,http/1.1
    http-request set-header X-Forwarded-Proto https
    http-request set-header X-Forwarded-Host  %[req.hdr(host)]
    http-request set-header X-Forwarded-For   %[src]

    acl host_memory hdr(host) -i memory.dnspegasus.net
    use_backend shared_memory if host_memory

backend shared_memory
    option forwardfor
    # Replace 127.0.0.1 with the IP of the host running docker compose.
    # Port is APP_PORT from .env (default 3000).
    server app1 127.0.0.1:3000 check inter 5s
```

Things to verify:

- `PUBLIC_URL` in `.env` matches the public URL HAProxy serves (scheme + host).
- HAProxy is sending `X-Forwarded-Proto`, `X-Forwarded-Host`, and
  `X-Forwarded-For` (the snippet above does). Auth.js reads these to build
  the OIDC callback URL — without them, the callback may point at
  `http://...:3000` and Authentik will reject it.
- The Authentik Web-UI provider's **Redirect URI** is the public callback,
  not the internal one. E.g. `https://memory.dnspegasus.net/api/auth/callback/authentik`.

If your HAProxy lives on a different host than Docker, change `127.0.0.1`
to the Docker host's address (and confirm `APP_BIND=0.0.0.0` so the port
listens on all interfaces).

---

## Local development (no TLS)

For development against a local Authentik, you can skip Caddy and run the app
directly:

```bash
pnpm install
cp .env.example .env  # set PUBLIC_URL=http://localhost:3000 etc.
docker compose up -d db
pnpm db:migrate
pnpm dev
```

The Authentik provider you use locally must accept
`http://localhost:3000/api/auth/callback/authentik` as a redirect URI.

---

## Troubleshooting

- **`401 claim invalid: aud`** from `/api/mcp` — your MCP provider isn't
  emitting `aud`. See **Setting the `aud` claim** above.
- **Auth.js callback fails with `OAUTH_CALLBACK_ERROR`** — your `PUBLIC_URL`
  doesn't match the redirect URI Authentik is configured with. They must be
  exactly equal, scheme and trailing slash included.
- **Caddy can't get a cert** — confirm DNS points to your host and ports
  80/443 are reachable. Uncomment the staging CA line in `Caddyfile` while
  testing to avoid hitting the production rate limit.
- **`pg_isready` healthcheck loops** — check that `POSTGRES_USER` /
  `POSTGRES_PASSWORD` / `POSTGRES_DB` are all set in `.env`.

---

## Project layout

```
shared-memory/
├── apps/web/                        # Next.js app (UI + MCP endpoint)
│   ├── app/
│   │   ├── page.tsx                 # landing
│   │   ├── me/page.tsx              # auth debug page
│   │   ├── api/auth/[...nextauth]/  # NextAuth handler
│   │   ├── api/mcp/                 # MCP streamable-HTTP endpoint
│   │   ├── api/health/              # /api/health for compose healthcheck
│   │   └── .well-known/oauth-protected-resource/  # RFC 9728
│   ├── auth.ts                      # NextAuth + Authentik provider config
│   ├── lib/
│   │   ├── env.ts                   # Zod env validation
│   │   ├── auth/jwt.ts              # MCP bearer JWT verification (JWKS)
│   │   ├── db/                      # Drizzle schema + client
│   │   └── mcp/                     # MCP dispatcher + tools
│   ├── drizzle/0000_init.sql        # initial migration (manual SQL)
│   ├── scripts/migrate.ts           # migration runner
│   └── Dockerfile
├── packages/schemas/                # shared Zod schemas (UI ↔ MCP)
├── docker-compose.yml
├── Caddyfile
└── .env.example
```

## License

MIT.
