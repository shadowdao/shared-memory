# OIDC provider setup: Microsoft Entra ID

Companion to the **OIDC provider setup** section in [`README.md`](../README.md),
which walks through Authentik. The structure here deliberately mirrors it —
app registration A (Web UI), app registration B (MCP resource server), env var
mapping, verification — so the two are diffable. Where Entra genuinely differs
from Authentik, the difference is called out rather than smoothed over.

Everything below assumes a **single-tenant** deployment (`signInAudience` =
"Accounts in this organizational directory only"). Multitenant is possible but
the `iss` verification in `apps/web/lib/auth/jwt.ts` compares against a fixed
string, so it would need code changes — see [Multitenant](#13-multitenant-is-not-supported)
at the end.

---

## 0. Prerequisite: your build must have JWKS discovery

**Check this first. Nothing else in this document works without it.**

Until recently `apps/web/lib/auth/jwt.ts` hardcoded the JWKS location as
`${issuer}/jwks/`. That is an *Authentik* convention, not a standard — RFC 8414
says the key set lives wherever the discovery document's `jwks_uri` points, and
Entra puts it somewhere else entirely:

| IdP | JWKS URL |
|---|---|
| Authentik | `https://auth.example.com/application/o/<slug>/jwks/` |
| Entra ID | `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys` |

With the path hardcoded, every Entra-issued MCP access token fails verification
because the key set fetch 404s. There is no configuration that works around it;
MCP authentication is simply impossible.

The current code resolves `jwks_uri` from
`${OIDC_ISSUER_MCP or OIDC_ISSUER}/.well-known/openid-configuration`, caches the
result for the process lifetime, and falls back to `${issuer}/jwks/` only if
discovery is unreachable (so existing Authentik deployments are untouched).

Confirm your deployment has it before debugging anything else:

```bash
# Should return the Entra keys endpoint, not a 404.
curl -s "https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration" \
  | jq -r .jwks_uri
# → https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys
```

If MCP calls 401 with `error_description="verification failed"` and your app
logs show a fetch to `.../v2.0/jwks/`, you are on an older build.

---

## 1. Concepts, Authentik → Entra

| Concept here | Authentik | Entra ID |
|---|---|---|
| OAuth2 client | Provider + Application | App registration |
| Issuer | Per-application (`.../application/o/<slug>/`) | **Per-tenant only** — one issuer for the whole directory |
| Audience claim | Scope mapping returning `{"aud": …}` | "Expose an API" scope on the resource app; `aud` is set automatically |
| Redirect URI matching | Regex allowed (any port) | **Exact string match**, with one loopback exception |
| Dynamic client registration | Not implemented | Not implemented |

The **issuer** row is the one that reshapes the setup. On Authentik, the Web UI
and MCP endpoint are separate applications with separate issuers, which is why
`OIDC_ISSUER_MCP` exists. Entra has exactly one issuer per tenant no matter how
many app registrations you create, so **`OIDC_ISSUER_MCP` is left unset on
Entra** and `mcpIssuer()` falls through to `OIDC_ISSUER`.

You still create **two app registrations**, for the same reason as on Authentik:
one confidential client for the browser sign-in, one resource server that owns
the audience the MCP endpoint validates. (A third participant — the *public
PKCE client* Claude Code uses — is covered in §4; you can fold it into
registration B or split it out.)

---

## 2. Find your tenant ID and use it explicitly

Everywhere below, `<tenant-id>` is your directory (tenant) GUID, from
**Entra admin center → Overview → Tenant ID**.

**Do not use the `common` or `organizations` authority.** Their discovery
documents return a *templated* issuer — the literal string, verified live:

```bash
curl -s https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration | jq -r .issuer
# → https://login.microsoftonline.com/{tenantid}/v2.0
```

That `{tenantid}` is not a formatting artifact; it is what the endpoint really
returns. `jwt.ts` compares `iss` by exact string (via `acceptedIssuers()`), so
against a templated issuer **no token can ever match** and every MCP call fails
with `claim invalid: iss`.

Microsoft's documented pattern for multitenant apps is to substitute the token's
`tid` claim into the placeholder and then compare — this app does not do that
(see [Multitenant](#13-multitenant-is-not-supported)). For single-tenant, the fix
is simply to use the tenant-specific authority, whose discovery document
returns a concrete issuer:

```bash
curl -s "https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration" | jq -r .issuer
# → https://login.microsoftonline.com/<tenant-id>/v2.0     (no trailing slash)
```

A verified domain (`contoso.onmicrosoft.com`) also works as the authority
segment — Entra resolves it server-side and returns the GUID form in both
`issuer` and `jwks_uri`. Since the *returned* issuer is what tokens carry,
`OIDC_ISSUER` must be the GUID form regardless of which you typed.

---

## 3. App registration A — Web UI (confidential client)

**Entra admin center → Entra ID → App registrations → New registration**

- **Name:** `shared-memory-web`
- **Supported account types:** Accounts in this organizational directory only
- **Redirect URI:** platform **Web**, value:
  ```
  https://memory.example.com/api/auth/callback/oidc
  ```
  (replace with your `PUBLIC_URL`; the `/oidc` suffix comes from the provider
  id in `apps/web/auth.ts` and is not configurable without a code change)

Register, then collect:

- **Overview → Application (client) ID** → `.env` as `OIDC_CLIENT_ID_WEB`
- **Certificates & secrets → New client secret** → `.env` as
  `OIDC_CLIENT_SECRET_WEB` (copy the *Value*, not the Secret ID; it is shown
  once)

**API permissions:** `openid`, `profile`, `email` are Microsoft Graph delegated
permissions and are present by default via `User.Read`. Add `profile`
explicitly if it is missing — it gates the `oid` and `tid` claims, which
matter for §7.

No "Expose an API" configuration is needed on this registration. Auth.js only
consumes the ID token here.

---

## 4. App registration B — MCP resource server

This registration is what `OIDC_AUDIENCE` refers to. It owns the API scope that
Claude Code requests, and the MCP endpoint validates that tokens were minted
for it.

**App registrations → New registration**

- **Name:** `shared-memory-mcp`
- **Supported account types:** same as A

### 4a. Set the access token version — the single most common failure

**Manage → Manifest**, find and set:

```json
"api": {
    "requestedAccessTokenVersion": 2
}
```

There is no checkbox for this; it is a manifest edit.

> **Note on the property name.** Older guides (and older versions of this
> project's notes) call this `accessTokenAcceptedVersion` at the top level of
> the manifest. That is the **retired Azure AD Graph** manifest format —
> Microsoft removed it from the portal's manifest editor on 2025-01-07, so you
> will not find that property. The current Microsoft Graph app manifest nests
> it as `api.requestedAccessTokenVersion`. The semantics are identical:
> `null` or `1` → v1.0 tokens, `2` → v2.0 tokens.

Leave it at the default `null` and Entra issues **v1.0** access tokens, whose
issuer is:

```
https://sts.windows.net/<tenant-id>/          ← note the trailing slash
```

not `https://login.microsoftonline.com/<tenant-id>/v2.0`. Verification then
fails with `claim invalid: iss`, and — because everything else in the OAuth
handshake succeeded — it looks like a mysterious 401 rather than a
configuration error.

The setting lives on the **resource** app and wins over whichever endpoint the
client used: with `requestedAccessTokenVersion: 2`, a client hitting the v1.0
endpoint still receives a v2.0 access token.

### 4b. Expose an API

**Manage → Expose an API**

1. **Application ID URI** → *Add* → accept the default `api://<client-id-of-B>`.
2. **Add a scope**:
   - **Scope name:** `access_as_user`
   - **Who can consent:** **Admins and users** (see §9)
   - Fill in the admin/user consent display strings; they appear on the consent
     prompt.

The resulting full scope string is `api://<client-id-of-B>/access_as_user`.

### 4c. The public PKCE client (Claude Code)

Claude Code is a public client using PKCE. Add a platform to registration B
(or to a third registration if you prefer them separated — then that
registration's client ID is `OIDC_CLIENT_ID_MCP`, and it needs
`api://<client-id-of-B>/access_as_user` under **API permissions**):

**Manage → Authentication → Add a platform → Mobile and desktop applications**

> **The platform type is not cosmetic.** A redirect URI registered under the
> **Web** platform classifies the app as a *confidential* client, and the
> token exchange then demands a `client_secret` or `client_assertion` —
> Claude Code has neither, so the flow dies with
> `AADSTS7000218: The request body must contain the following parameter:
> 'client_assertion' or 'client_secret'`. The portal will happily accept
> `http://localhost:33418/callback` as a Web redirect URI, which is what makes
> this trap easy to fall into. **Mobile and desktop applications**
> (`publicClient` in the manifest) is the correct platform. SPA is not an
> option either — Entra rejects SPA redirect URIs for non-SPA flows.

Under **Custom redirect URIs**, register:

```
http://localhost/callback
https://memory.example.com/auth/cli-callback
```

The first covers the loopback listener from README → *B. OAuth flow*; the
second is the manual-paste fallback from *C*. "Mobile and desktop
applications" permits arbitrary `https://` URIs alongside the loopback one, so
both live on the same platform.

**Note the missing port.** Entra ignores the port component when matching
`http://localhost` redirect URIs, so the single registration
`http://localhost/callback` matches `http://localhost:33418/callback`,
`http://localhost:9999/callback`, and any other port. This is Entra's
equivalent of the Authentik regex (`^http://(127\.0\.0\.1|localhost):\d+/.*$`)
the README mentions — users can pick any `--callback-port` without
re-registering.

Three constraints on that convenience:

- **The path is still matched exactly.** Registering bare `http://localhost`
  does *not* match `http://localhost:33418/callback`. The `/callback` suffix
  must be there, and paths are case-sensitive.
- **Do not register several localhost URIs differing only by port.** Entra
  picks one arbitrarily when matching.
- **Port-agnostic matching is documented for `localhost` only**, not for
  `127.0.0.1` — and the portal text box refuses the `http://127.0.0.1` form
  anyway (it requires a manifest edit). Use `localhost`. `[::1]` is not
  supported at all.

You do **not** need to enable **Allow public client flows**
(`allowPublicClient`). That toggle is a *fallback* for flows where Entra can't
infer the client type from a redirect URI — device code, ROPC, Windows
Integrated Auth. Authorization code + PKCE with a registered
mobile-and-desktop redirect URI is inferred correctly without it. (Entra's own
`reply-url` doc says otherwise in one sentence; the manifest reference and the
AADSTS7000218 troubleshooting article agree it is a fallback. Leave it off
unless you hit a problem — Microsoft warns that flipping a confidential client
to public has security implications.)

**Application (client) ID** of whichever registration Claude Code
authenticates as → `.env` as `OIDC_CLIENT_ID_MCP`.

---

## 5. `OIDC_AUDIENCE` vs. `OIDC_AUDIENCE_SCOPE`

On Authentik these two look redundant — the scope mapping is named
`aud-shared-memory` and it emits `aud: shared-memory`, so the values track each
other. On Entra they are **necessarily different strings**, and swapping them is
the easiest mistake to make here.

| Var | What it is | Entra value |
|---|---|---|
| `OIDC_AUDIENCE` | The `aud` claim `jwt.ts` requires on the token | `<client-id-of-B>` — a bare GUID |
| `OIDC_AUDIENCE_SCOPE` | The scope string the *client* asks for, advertised in `/.well-known/oauth-protected-resource` | `api://<client-id-of-B>/access_as_user` |

Why they differ: the client requests a scope by its full URI
(*Application ID URI* + `/` + scope name), but Entra does not put that URI in the
token. For **v2.0** access tokens it splits the request into `aud` (the API's
**client-ID GUID**) and `scp` (the **short** scope name, `access_as_user`).
Three distinct strings for what feels like one concept.

> **Do not trust this document — decode a real token.** Microsoft's own
> [access-tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens)
> page says web APIs "must only accept tokens containing one of their AppId
> URIs as the `aud` claim", which contradicts the authoritative
> [access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)
> ("In v2.0 tokens, this value is always the client ID of the API"). The
> claims reference is correct for v2.0, but given that Microsoft's docs
> disagree with each other, verify empirically — see §8.

`OIDC_AUDIENCE_SCOPE` **must** be set explicitly on Entra. Left unset, the code
defaults to `aud-${OIDC_AUDIENCE}`, which is an Authentik naming convention and
means nothing to Entra — the client would request a nonexistent scope and the
authorize request fails outright.

---

## 6. `offline_access`

Set `OIDC_OFFLINE_ACCESS=true` from the start. Unlike Authentik — where you must
first attach an `offline_access` scope mapping to the provider — Entra treats
`offline_access` as one of its well-defined platform scopes (`openid`, `email`,
`profile`, `offline_access`). Nothing to create, and it is **implicitly
granted**: if any delegated permission is consented, `offline_access` is too.

Two caveats:

- It must still be *requested* at runtime, which is exactly what
  `OIDC_OFFLINE_ACCESS=true` achieves — the flag adds it to `scopes_supported`
  in `/.well-known/oauth-protected-resource`, and MCP clients only request
  scopes they see advertised there.
- A refresh token comes back only on authorization-code-style flows. That is
  what Claude Code uses, so this is satisfied; implicit flow would not be.

The `.env` comment on this var warns that advertising a scope the IdP doesn't
offer risks `invalid_scope`. On Entra that risk doesn't apply.

---

## 7. Identity: `sub` splits accounts across app registrations

**Handled as of migration `0005_user_oid.sql`. Read this anyway — it explains
why `oid` is in your database, and what happens if you deploy the migration
late.**

The app keys the `users` row on `(oidc_iss, oidc_sub)` — see the upsert in
`apps/web/lib/mcp/context.ts` and the one in `apps/web/auth.ts`. On Authentik
that is safe, because Authentik's `sub` is `user.uid`, a user-level value that
is identical across providers.

Entra's `sub` is a **pairwise identifier**. Microsoft documents it as *"based on
a combination of the token recipient, tenant, and user"* — so the value is
scoped to the app registration in the `aud` position of that particular token:

- Web UI sign-in → ID token with `aud` = registration **A** → `sub` = *X*
- MCP access token → `aud` = registration **B** → `sub` = *Y*

*X ≠ Y*, by design, for privacy. `iss` is identical for both (one tenant, one
issuer), so `(iss, sub)` yields **two different keys for the same human**. Both
code paths *upsert* rather than fail, so nothing looks broken: the person signs
into the Web UI, sees their memories, connects Claude Code, and finds an empty
account. Writes land in the second row.

There is no configuration fix. `sub` is in Entra's restricted claim set (no
claims-mapping policy can alter it), `subject_types_supported` advertises only
`pairwise`, and Microsoft has stated that `sector_identifier_uri` is not used to
generate it.

**How it's handled.** Identity is keyed on `oid` — the directory object id,
which Microsoft documents as constant for a user across every application in a
tenant (*"all apps get the same `oid` and `tid` claims for a user acting in a
tenant"*). It is emitted by default in v2.0 ID *and* access tokens as long as
the `profile` scope is requested, which it is.

`apps/web/lib/auth/identity.ts` holds the single resolver both surfaces call.
Resolution order when `oid` is present:

1. an existing row keyed on `(oidc_iss, oidc_oid)` — the steady state
2. a pre-migration row matching `(oidc_iss, oidc_sub)` with no `oid` yet, which
   gets its `oid` backfilled in place
3. insert

IdPs that emit no `oid` (Authentik, Keycloak, Okta) skip straight to the
original `(iss, sub)` behaviour, unchanged.

> **One upgrade-ordering caveat.** Step 2 adopts a legacy row by matching
> `sub`, and the only `sub` that can match is the one that created it — the
> **Web UI** one, since MCP auth against Entra was impossible before the JWKS
> fix in §0. So if you already had Entra users signing into the Web UI, have
> them **sign into the Web UI once** after deploying this migration, before
> connecting an MCP client. Connecting MCP first creates a fresh row keyed on
> `oid` and leaves the original stranded, with the memories in it invisible.
> Deployments that have never run Entra are unaffected.

The single-registration layout (making registration A the resource server too)
also works and needs no migration, but you lose audience separation between the
Web UI and MCP.

---

## 8. Verification

Run these in order; each one isolates a different failure.

**1. The issuer is concrete, not templated.**

```bash
curl -s "https://login.microsoftonline.com/<tenant-id>/v2.0/.well-known/openid-configuration" \
  | jq '{issuer, jwks_uri}'
```
`issuer` must be a GUID URL, not `{tenantid}`. Copy it verbatim into
`OIDC_ISSUER`.

**2. Our metadata advertises the right scopes.**

```bash
curl -s https://memory.example.com/.well-known/oauth-protected-resource | jq
```
`scopes_supported` must contain `api://<client-id-of-B>/access_as_user` (not
`aud-…`), plus `offline_access` if you enabled it. `authorization_servers[0]`
must be the tenant-specific v2.0 issuer.

**3. Decode a real access token.** This is the only step that proves the
`aud`/`iss`/version questions. Get a token (from Claude Code's stored
credentials, or by running the flow manually) and inspect the payload:

```bash
TOKEN='eyJ...'
echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq '{ver, iss, aud, sub, oid, tid, scp, groups}'
```

Expected:

| Field | Expected value | If wrong |
|---|---|---|
| `ver` | `"2.0"` | `api.requestedAccessTokenVersion` is not `2` (§4a) |
| `iss` | `https://login.microsoftonline.com/<tenant-id>/v2.0` | v1 token, or `common` authority (§2, §4a) |
| `aud` | `<client-id-of-B>`, a bare GUID | set `OIDC_AUDIENCE` to whatever is actually here (§5) |
| `scp` | `access_as_user` | the scope wasn't requested or consented (§9) |
| `groups` | array of GUIDs, or absent | see §10 |

**4. Confirm the 401 reason** when something is still wrong — the MCP endpoint
names the failing claim:

```bash
curl -s -i -H "Authorization: Bearer $TOKEN" https://memory.example.com/api/mcp | head -20
```
Look at `WWW-Authenticate`: `error_description="claim invalid: iss"` →
§2/§4a. `"claim invalid: aud"` → §5. `"verification failed"` → JWKS could not
be fetched, §0.

---

## 9. Consent for the API scope

A custom scope is not inherently admin-only. Two levers decide it:

- **The scope's own setting.** "Who can consent?" on the scope — **Admins and
  users** lets users self-consent; **Admins only** always requires an admin.
  Select "Admins and users" (§4b). Microsoft's docs don't state which radio the
  portal preselects, so set it deliberately rather than assuming.
- **The tenant's user-consent policy.** The default is *"users are allowed to
  consent to applications for permissions that don't require administrator
  consent"*, but many tenants tighten this to "verified publishers only" or
  disable user consent entirely, in which case an admin must consent regardless
  of the scope setting.

Admin consent becomes **mandatory** if: the scope is "Admins only"; the tenant
policy restricts user consent; or — the one that catches people — the enterprise
application is set to **require user assignment**, which forces admin consent
even when tenant policy would otherwise permit self-consent.

**To grant it:** App registrations → *the client app* (the one Claude Code uses,
not the API) → **API permissions** → **Grant admin consent for \<tenant\>**. The
button is disabled if you aren't an admin or no permissions are configured.

Alternatively, suppress the prompt entirely with **pre-authorization**: on
registration B, **Expose an API → Authorized client applications → Add a client
application**, select the MCP client ID and tick `access_as_user`. Consent is
then implicit. Reasonable here, since you control both registrations.

If you prefer the URL form of admin consent, note it needs the `/v2.0/` segment
and must not use `common`:

```
https://login.microsoftonline.com/<tenant-id>/v2.0/adminconsent
  ?client_id=<OIDC_CLIENT_ID_MCP>
  &scope=api://<client-id-of-B>/access_as_user
  &redirect_uri=https://memory.example.com/auth/cli-callback
  &state=12345
```

---

## 10. Groups

Group memberships gate access to shared projects (`readableProjectIds` /
`canWriteProject` in `apps/web/lib/mcp/tools.ts` and
`apps/web/lib/memory-mutations.ts`). Entra's groups claim needs care on two
independent axes: **what the values look like**, and **what happens when the
claim goes missing**.

### 10a. By default you get GUIDs, not names

Entra emits `groups` as a **JSON array of group object-ID GUIDs**. Not display
names. `apps/web/lib/auth/sync-groups.ts` stores whatever strings arrive
verbatim and makes no attempt to resolve them, so the Web UI will list
memberships like `8f4c…-b21a` and your project ACLs must be written against
those GUIDs.

There *is* a supported way to get display names for cloud-only groups —
contrary to the older note in `sync-groups.ts`, which says names are available
only for AD-synced groups. That was true of the `sam_account_name` family
(those attributes genuinely exist only on groups synced from on-premises AD via
Entra Connect 1.2.70+), but Entra also has `cloud_displayname`:

**App registrations → \<B\> → Token configuration → Add groups claim**, select
**Groups assigned to the application**, then tick the cloud-only display name
option. In the manifest:

```json
"groupMembershipClaims": "ApplicationGroup",
"optionalClaims": {
  "accessToken": [
    { "name": "groups",
      "additionalProperties": ["cloud_displayname"] }
  ],
  "idToken": [
    { "name": "groups",
      "additionalProperties": ["cloud_displayname"] }
  ]
}
```

Both collections matter: `idToken` feeds the Web UI sign-in path (`auth.ts`),
`accessToken` feeds the MCP path (`jwt.ts`). Configure only one and the two
surfaces disagree about your group names.

Constraints, all of them load-bearing:

- `cloud_displayname` **only works with `groupMembershipClaims:
  "ApplicationGroup"`**. Microsoft's stated reason is that group display names
  aren't unique, so they only emit them for groups explicitly assigned to the
  application.
- Only **directly assigned** groups appear. **Nested groups are excluded.**
- Assign the groups under **Enterprise applications → \<B\> → Users and
  groups**, or they simply won't be emitted.
- Microsoft's published `cloud_displayname` examples cover `idToken` and
  `saml2Token`; we found no official example pairing it with `accessToken`.
  It is a documented-valid collection, but **decode a real access token (§8)
  and confirm `groups` contains names before relying on it** rather than
  assuming symmetry.

A claims-mapping policy cannot fix this instead: `groups` is a restricted
claim, so its data source can't be changed and no transformation applies.

If none of this appeals, Microsoft's own recommendation is to use **app roles**
rather than groups for authorization — but this app reads `groups`, so that
would need a code change.

### 10b. Groups overage — now refused rather than obeyed

**This was the sharpest edge in this document. It is now a hard failure with a
readable message, which is a much better outcome than what it used to do.**

Past a limit, Entra stops emitting `groups` altogether and substitutes an
overage indicator:

| Token | Limit | What you get past it |
|---|---|---|
| JWT (access + ID) | **200** groups | `groups` absent; `_claim_names` / `_claim_sources` present |
| SAML | 150 groups | same |
| Implicit flow | **5** groups | `"hasgroups": true` |

The indicator looks like this — note it is *not* a truncated list, it is no
list at all:

```json
{
  "_claim_names":   { "groups": "src1" },
  "_claim_sources": { "src1": { "endpoint": "https://graph.windows.net/…" } }
}
```

(That endpoint is an **Azure AD Graph** URL, not Microsoft Graph. Don't follow
it; Microsoft says to construct
`https://graph.microsoft.com/v1.0/users/{id}/getMemberObjects` yourself.
Limits are inclusive of nested groups.)

**What this used to do.** An absent `groups` claim and a claim saying "zero
groups" were indistinguishable to `normalizeGroupsClaim`, which returned `[]`
for both — and the `names.length === 0` branch **deletes every one of that
user's `user_groups` rows**. So a user crossing 200 groups signed into the Web
UI once and silently lost access to every shared project, on both surfaces,
with no error anywhere. (The MCP path never deleted anything, but it then read
the snapshot the Web sign-in had just emptied.)

**What happens now.** `detectGroupsOverage` looks for `_claim_names.groups` and
`hasgroups`, and both surfaces refuse the token rather than acting on group
state they know they don't have:

- **Web sign-in** throws `GroupsOverageError`, which fails the sign-in. Existing
  memberships are left completely untouched.
- **MCP** returns 401 with
  `error_description="groups overage: IdP did not enumerate group membership …"`.

The user is blocked until an admin fixes the claim configuration — and then
signs in and finds their access exactly as it was. Nothing to restore, because
nothing was destroyed. Granting access from a stale snapshot, or revoking it on
a claim the IdP never made, are both guesses; refusing is the only honest
answer available.

An absent `groups` claim with **no** overage marker still clears memberships.
That is unchanged and deliberate: the IdP has genuinely stopped asserting the
groups, so we stop honouring them.

#### Getting a blocked user back in

1. App registration → **Token configuration** (or the manifest) → set
   `groupMembershipClaims` to **`ApplicationGroup`** — the portal labels this
   **"Groups assigned to the application"**. It emits only the groups
   explicitly assigned to *this* application, which for a memory server is a
   handful, so the 200-group ceiling stops being reachable. Microsoft
   recommends it for exactly this reason, and it is the same setting
   `cloud_displayname` requires — §10a and §10b have one shared fix.
2. Enterprise applications → your app → **Users and groups** → assign the
   groups you actually share projects with. `ApplicationGroup` emits **directly
   assigned groups only**; nested and transitive membership is excluded, so
   assign the real groups rather than a parent.
3. Confirm the `groups` optional claim is configured for the **access token**,
   not only the ID token — the MCP path reads the access token.
4. The user signs in again. Their memberships were never deleted, so their
   access returns as it was.

Leaving `groupMembershipClaims` at `All` or `SecurityGroup` in a large tenant is
what makes this bite in the first place.

If a group genuinely must exceed the limit, the other way out is **app roles**,
which are app-scoped and never overage — but they arrive in a `roles` claim and
this codebase reads `groups`, so that is a code change, not a config change.

---

## 11. Connecting Claude Code

Everything in README → **Connecting Claude Code** applies unchanged, with one
Entra-specific confirmation: **the pre-registered client-id path is
mandatory.**

Entra does not implement RFC 7591 Dynamic Client Registration. Its discovery
document publishes no `registration_endpoint`, it serves no RFC 8414
authorization-server metadata at all (only OIDC discovery), and it does not
advertise `client_id_metadata_document_supported` — so neither DCR nor the CIMD
mechanism that superseded it in the MCP spec is available. Microsoft states this
plainly in its own MCP guidance ("Microsoft Entra ID doesn't currently support
client registration") and has said it is not on the near-term roadmap.

Practically, this means:

- Use the plugin (`plugin/.mcp.json` ships a pre-registered `clientId`), or
- Pass `--client-id <OIDC_CLIENT_ID_MCP>` explicitly on `claude mcp add`.

A client that expects to self-register will fail. This is the same situation as
Authentik, so the README's guidance needs no adjustment.

---

## 12. Env var reference card

Straight from Entra's UI labels to `.env` keys. `<A>` is app registration A
(Web UI, §3); `<B>` is app registration B (MCP resource server, §4).

| `.env` key | Where it comes from in Entra | Example |
|---|---|---|
| `OIDC_ISSUER` | `issuer` from the **tenant-specific** discovery document (§2). Not the authority you typed — the value the endpoint returns. | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| `OIDC_ISSUER_MCP` | **Leave unset.** Entra has one issuer per tenant; there is no per-application issuer to point at. `mcpIssuer()` falls back to `OIDC_ISSUER`. | *(unset)* |
| `OIDC_CLIENT_ID_WEB` | `<A>` → **Overview → Application (client) ID** | `1111…-aaaa` |
| `OIDC_CLIENT_SECRET_WEB` | `<A>` → **Certificates & secrets → Client secrets → Value** (not Secret ID; shown once) | `abc8Q~…` |
| `OIDC_CLIENT_ID_MCP` | Client ID of the **public PKCE** registration Claude Code authenticates as (§4c) | `3333…-cccc` |
| `OIDC_AUDIENCE` | `<B>` → **Overview → Application (client) ID**. The bare GUID, *not* the `api://` URI. Confirm by decoding a token (§8). | `2222…-bbbb` |
| `OIDC_AUDIENCE_SCOPE` | `<B>` → **Expose an API** → the scope's full string: Application ID URI + `/` + scope name. Must be set explicitly; the `aud-…` default is Authentik-only. | `api://2222…-bbbb/access_as_user` |
| `OIDC_OFFLINE_ACCESS` | Nothing to configure in Entra — set it to `true` (§6). | `true` |

`PUBLIC_URL` and the non-OIDC vars are unchanged from the README.

---

## 13. Multitenant is not supported

`acceptedIssuers()` in `apps/web/lib/auth/jwt.ts` compares `iss` against a
fixed pair of strings (with and without a trailing slash). Multitenant Entra
apps require substituting each token's `tid` claim into the `{tenantid}`
placeholder before comparing, and separately validating the signing key's own
issuer. Neither is implemented.

Beyond `iss`, multitenant would also need the identity keying in §7 resolved,
since Microsoft is explicit that `oid` and `sub` differ per tenant by design and
that a guest user authenticating in another tenant *"should be treated as if
they're a brand new user to the service."*

Single-tenant is the supported configuration.
