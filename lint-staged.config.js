/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  '*.rs': (_files) => [
    'bun run build',
    'cargo fmt',
    'cargo clippy --workspace --fix --allow-dirty',
  ],
  '*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx,json,jsonc}': [
    'biome check --write --no-errors-on-unmatched',
  ],
  '*.toml': ['taplo format'],
};
