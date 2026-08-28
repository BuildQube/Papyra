# @workspace/pdf-viewer

## 0.1.0

### Minor Changes

- a81edba: The registry is versioned from here on. It is never published to npm, but its items
  are installed by URL, so this changelog is the only record a consumer of them has of
  what changed under an item's name.
  
  The five blocks moved from `src/components` to `src/blocks`. Installed output is
  unaffected — `shadcn add` takes a file's directory from its `type`, so both land in
  the consumer's `components` alias under the same name — and the built items differ
  only in the `path` string they carry.

### Patch Changes

- Updated dependencies [0b71c9c]
- Updated dependencies [e9d30cc]
  - @build-qube/papyra@0.2.0
