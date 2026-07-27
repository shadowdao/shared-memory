# instance/triple-c

Orphan branch — plugin manifests only, for the `triple-c` container.

Identical to `instance/dnspegasus` except **`callbackPort` is 5693** instead of
33418. The container can only receive an OAuth loopback callback on a port that
is mapped through from its host, and 5693 is the one that is.

```bash
claude plugin marketplace add "https://repo.anhonesthost.net/cybercove-labs/shared-memory.git#instance/triple-c"
claude plugin install shared-memory@triple-c
```

Never merge `main` into this branch — see `instance/dnspegasus`'s README.
