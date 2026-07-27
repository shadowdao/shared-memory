# instance/dnspegasus

This branch is **not** a fork of the project. It is an orphan branch holding
exactly three files: the Claude Code plugin manifests for one live instance,
filled in with that instance's real server URL and OAuth client ID.

```
.claude-plugin/marketplace.json      marketplace named `dnspegasus`
plugin/.claude-plugin/plugin.json    plugin manifest
plugin/.mcp.json                     server URL + pre-registered OAuth client
```

Install from it with a `#ref` fragment:

```bash
claude plugin marketplace add "https://repo.anhonesthost.net/cybercove-labs/shared-memory.git#instance/dnspegasus"
claude plugin install shared-memory@dnspegasus
```

## Why it's an orphan branch

It used to be a normal branch off `main`, which was wrong twice over:

- It carried a full copy of the application it had no reason to have, so it
  drifted behind `main` and a stale deploy could have been cut from it.
- Syncing it meant `git merge origin/main`, which **silently replaced these
  three manifests** with `main`'s public placeholders. No conflict was raised,
  because only `main` had touched those paths.

With no shared history there is nothing to sync and nothing to clobber. Never
merge `main` into this branch — if the manifest *format* changes upstream,
hand-edit these files and run `claude plugin validate .`.

`main` carries the same three files with placeholder values, as the public
template. The real values live only here.

## The client ID is not a secret

`clientId` is a **Public** (PKCE) OAuth client. It is meant to be committed —
it identifies the client, it does not authenticate it. Access is controlled by
the bindings on the IdP application, not by keeping this string private.
