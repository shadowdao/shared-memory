# shared-memory

A self-hosted MCP server that gives Claude Code sessions a **shared, persistent
memory** plus a **reusable snippet library**, behind your own OIDC login.
Includes a Web UI for reviewing, editing, and deleting what's been stored.

Works with any OIDC-compliant identity provider — Authentik (the worked
example below), Microsoft Entra ID, Keycloak, Okta, Auth0, Zitadel, Google
Workspace. Anything that publishes a `/.well-known/openid-configuration`.

> **Status:** Phase 2 — memory with hybrid (vector + FTS + tags) search,
> OIDC-authed Web UI, MCP endpoint with JWKS-validated bearer tokens.
> Rich Web UI lands in Phase 3.

---

## Architecture

```
┌─────────────────┐        ┌───────────────────────┐        ┌─────────────────┐
│  Claude Code    │──MCP──▶│  shared-memory app    │◀──OIDC─│  Your OIDC IdP  │
│  (many sessions)│  HTTP  │  Next.js + MCP route  │        │  (Authentik /   │
└─────────────────┘        │  + Web UI             │        │   EntraID /     │
                           └───────────┬───────────┘        │   Keycloak/...) │
                                       │                    └─────────────────┘
                                       │                          ▲
                                ┌──────▼──────┐         user logs in
                                │ Postgres 16 │         via web browser
                                │  + pgvector │
                                └─────────────┘
                                       ▲
                                 ┌─────┴─────┐
                                 │ embedder  │  (bge-small via Xenova
                                 │ sidecar   │   transformers, on-CPU)
                                 └───────────┘
```

The same container serves both the MCP endpoint (under `/api/mcp`) and the
Web UI. Users authenticate via your OIDC provider with pre-registered
confidential clients. Identity is keyed on the OIDC `sub` + `iss` so
memories are scoped per user.

---

## Prerequisites

- A host with **Docker** and **Docker Compose v2** installed.
- An **OIDC identity provider** you control (Authentik, EntraID, Keycloak,
  Okta, Auth0, Zitadel, …). The setup walkthrough below uses Authentik
  because that's what we run; other IdPs need equivalent settings.
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

### Mode C — AWS Fargate (Terraform)

For deployments where docker-compose on a VM isn't a fit (multi-AZ HA,
managed RDS, no host to babysit), the [`terraform/`](terraform/) directory
ships a module that wires the same three components into ECS Fargate
behind an ALB:

```bash
cd terraform/examples/basic
$EDITOR main.tf terraform.tfvars   # plug in your VPC, RDS, ACM, ECR, OIDC
terraform init && terraform apply
```

You bring the VPC, RDS Postgres, ACM cert, ECR images, and OIDC clients;
the module brings ECS, ALB, EFS (for the embedder model cache), Secrets
Manager, IAM, CloudWatch, and Service Connect for app↔embedder discovery.
Full walkthrough in [`terraform/README.md`](terraform/README.md), including
the post-apply migrator invocation and DNS setup.

---

## Quick start

```bash
git clone https://repo.anhonesthost.net/jknapp/shared-memory.git
cd shared-memory
cp .env.example .env
# edit .env — see "Configuration" and "OIDC provider setup" below
docker compose build
docker compose up -d                # Mode A (behind external proxy)
# OR
docker compose --profile tls up -d  # Mode B (built-in TLS)

# tail logs to watch migrations run + app come up
docker compose logs -f migrator app
```

When `app` reports `Listening on http://0.0.0.0:3000`, visit your
`PUBLIC_URL` and click **Sign in with OIDC**. You should land on
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
| `OIDC_ISSUER` | both | OIDC issuer URL for **this app**. Authentik uses `https://auth.example.com/application/o/<slug>/`; other IdPs vary. |
| `OIDC_CLIENT_ID_WEB` | both | Client ID of the Web-UI OAuth/OIDC client in your IdP. |
| `OIDC_CLIENT_SECRET_WEB` | both | Client secret of the Web-UI client. |
| `OIDC_CLIENT_ID_MCP` | both | Client ID of the MCP resource-server client in your IdP. |
| `OIDC_AUDIENCE` | both | Audience string the MCP access token must carry in its `aud` claim. Recommended: `shared-memory`. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | both | Local Postgres credentials. |
| `NEXTAUTH_SECRET` | both | Session-cookie signing key. Generate with `openssl rand -base64 32`. |
| `EMBEDDER_URL` | both | Phase 2 embedder sidecar. Leave empty in Phase 1. |
| `LOG_LEVEL` | both | `debug` / `info` / `warn` / `error`. |

Mode column: **A** = external proxy (default), **B** = built-in Caddy TLS.

---

## OIDC provider setup

You need **two** OAuth2 / OIDC clients on your identity provider:

- **Web UI client** — confidential, used when a human signs in through the
  browser to the Web UI
- **MCP resource-server client** — public (PKCE), used by Claude Code or any
  other MCP client to obtain access tokens scoped to the MCP endpoint

Reusing one client for both works, but the two-client setup keeps token
audiences cleanly separated and matches the rest of this doc.

The walkthrough below uses **Authentik** because that's what we run. The
shape is the same on any OIDC provider; the UI labels differ:

| Concept here | Authentik | Microsoft Entra ID | Keycloak |
|---|---|---|---|
| OAuth2 client | Provider + Application | App registration | Client |
| Redirect URI list | Provider's "Redirect URIs / Origins" | App's "Redirect URIs" | Client's "Valid Redirect URIs" |
| Audience claim | Scope mapping or property mapping | "Expose an API" + scope | Client scope with audience mapper |

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
  https://memory.dnspegasus.net/api/auth/callback/oidc
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

Two paths, in order of preference:

### A. OAuth flow (recommended — picks up your IdP credentials)

```bash
claude mcp add --transport http --scope user \
  --client-id <OIDC_CLIENT_ID_MCP> \
  --callback-port 33418 \
  shared-memory https://memory.dnspegasus.net/api/mcp
```

What happens:

1. Claude Code hits `/api/mcp`, gets 401 with our `WWW-Authenticate` header
2. It reads `/.well-known/oauth-protected-resource`, finds your OIDC issuer
3. It opens an authorize URL in your browser and starts a local listener
   on the `--callback-port` you specified
4. You authenticate with your IdP in the browser
5. The IdP redirects back to `http://localhost:33418/callback?code=…`,
   Claude Code's listener catches it, exchanges the code for an access
   token, and stores it

`--callback-port` is required because your IdP only accepts pre-registered
redirect URIs. Pick any free port; just make sure the matching URI is in
your MCP client's **Redirect URIs** list. Authentik users with the regex
pattern from the setup step (`^http://(127\.0\.0\.1|localhost):\d+/.*$`)
can use any port without re-registering.

### B. Manual-paste fallback (when loopback isn't reachable)

Sealed containers, devboxes without port forwarding, etc. The redirect URI
in this case is hosted by *this* server:

```bash
claude mcp add --transport http --scope user \
  --client-id <OIDC_CLIENT_ID_MCP> \
  --callback-port 0 \
  shared-memory https://memory.dnspegasus.net/api/mcp
```

When the loopback listener times out, Claude Code prompts you to paste the
callback URL. Open the authorize URL Claude Code printed in your browser,
sign in, and your IdP redirects to
`https://memory.dnspegasus.net/auth/cli-callback?code=…`. That page shows
the `code` and the full URL with copy buttons — paste either back into
Claude Code's prompt to complete the flow.

The manual-fallback URI must be registered on your MCP client too:
`https://memory.dnspegasus.net/auth/cli-callback`.

### C. Static bearer token (no browser at all)

For fully headless / CI scenarios, mint a long-lived HMAC token at
`https://memory.dnspegasus.net/connect` and pass it via `--header`. See
the `/connect` page for the exact `claude mcp add` command it generates
for you.

### Why no zero-config plugin yet

Claude Code plugins can ship an MCP server entry that handles OAuth
without any flags — but only when the auth server supports Dynamic Client
Registration (RFC 7591). Authentik is tracking DCR in
[goauthentik/authentik#8751](https://github.com/goauthentik/authentik/issues/8751);
once it ships we'll publish a plugin so the entire flow above collapses
to `/plugin install shared-memory`. Other IdPs that already support DCR
(Asana-style) can wire this up sooner.

[mcp-auth]: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

---

## Identifying the current project (`.shared-memory-project`)

When Claude Code calls memory.write / memory.search / etc., the server needs
to know *which* project the call belongs to. Resolution order, first match
wins:

1. **Explicit `project` argument** on the tool call.
2. **`.shared-memory-project` file** at the repo root — a single line of
   plain text containing the project key. Claude is instructed to read this
   first when a project context is present, before inferring or asking. This
   is the recommended path for any repo: commit the file, and every
   collaborator's Claude Code automatically attaches memories to the same
   shared project.
3. **`X-Project-Key` request header** — per-MCP-registration default, set at
   `claude mcp add` time with `--header "X-Project-Key: foo"`. Useful when a
   machine works in one project across many repos.
4. **Inference** — repo name / git remote slug / working-directory basename,
   as a last resort.

### Adding `.shared-memory-project` to your repo

```bash
echo "your-project-key" > .shared-memory-project
git add .shared-memory-project
git commit -m "chore: declare shared-memory project key"
```

The key must match the regex `^[a-zA-Z0-9._\-/]+$` (same constraint as the
`ProjectKey` Zod schema — alphanumerics plus `.`, `_`, `-`, `/`). Pick
something stable; renaming later is fine but breaks the implicit link with
any pre-existing memories you wrote against the old key.

### Why a flat-text file, not JSON

Matches the family of `.python-version`, `.nvmrc`, `.tool-versions` — easy
to grep, easy to author by hand, easy to read from any client without a
parser. If we ever need richer metadata (display name, default tags, etc.)
we'd graduate to a structured format, but the single-key case is the 95%.

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
  not the internal one. E.g. `https://memory.dnspegasus.net/api/auth/callback/oidc`.

If your HAProxy lives on a different host than Docker, change `127.0.0.1`
to the Docker host's address (and confirm `APP_BIND=0.0.0.0` so the port
listens on all interfaces).

---

## Local development (no TLS)

For development against a local IdP, you can skip Caddy and run the app
directly:

```bash
pnpm install
cp .env.example .env  # set PUBLIC_URL=http://localhost:3000 etc.
docker compose up -d db embedder
pnpm db:migrate
pnpm dev
```

The OIDC client you use locally must accept
`http://localhost:3000/api/auth/callback/oidc` as a redirect URI.

---

## Troubleshooting

- **`401 claim invalid: aud`** from `/api/mcp` — your MCP client isn't
  emitting an `aud` claim matching `OIDC_AUDIENCE`. On Authentik this is a
  scope mapping; on EntraID it's the API "Application ID URI"; on Keycloak
  it's a client-scope audience mapper. See **Setting the `aud` claim** above
  for the Authentik recipe; other IdPs need the equivalent in their UI.
- **Auth.js callback fails with `OAUTH_CALLBACK_ERROR`** — your `PUBLIC_URL`
  doesn't match the redirect URI your IdP is configured with. They must be
  exactly equal, scheme and trailing slash included.
- **Caddy can't get a cert** — confirm DNS points to your host and ports
  80/443 are reachable. Uncomment the staging CA line in `Caddyfile` while
  testing to avoid hitting the production rate limit.
- **`pg_isready` healthcheck loops** — check that `POSTGRES_USER` /
  `POSTGRES_PASSWORD` / `POSTGRES_DB` are all set in `.env`.
- **`/settings/groups` is empty even though I'm in groups** — your IdP isn't
  emitting a `groups` claim. On Authentik, edit the OIDC provider and add
  the built-in `authentik default OAuth Mapping: OpenID 'profile'` (or a
  custom property mapping that returns `{"groups": [g.name for g in
  request.user.ak_groups.all()]}`), then sign out and back in. On EntraID,
  add a "groups" optional claim under **Token configuration → Optional
  claims**; tick "Emit groups as group names" if you want names (we treat
  GUIDs as opaque strings). Keycloak: add a Group Membership mapper with
  "Full group path" off and the token claim name `groups`.

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
