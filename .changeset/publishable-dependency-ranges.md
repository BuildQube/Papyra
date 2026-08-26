---
"@build-qube/papyra": patch
---

Depend on `@build-qube/papyra-native` by version rather than `workspace:*`.

`workspace:` is a pnpm/yarn/bun protocol that those package managers rewrite while
packing. Changesets publishes through `npm publish`, which does not, so 0.0.3
shipped the literal string and failed to install with `EUNSUPPORTEDPROTOCOL`.
