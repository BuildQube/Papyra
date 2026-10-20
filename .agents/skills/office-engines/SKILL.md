---
name: office-engines
description: >
  Update papyra-office's rendering engines, WordCraft (.docx) and DeckCraft (.pptx),
  to newer upstream revisions and measure what changed. Use when asked to bump,
  update, upgrade or refresh WordCraft or DeckCraft, to "get the latest rendering",
  to check how far the office engines are behind upstream, or to judge whether an
  upstream fix (equations, WMF, a layout bug) has landed and is worth taking. Also
  use when a Word or PowerPoint rendering defect is reported, to check whether
  upstream has already fixed it.
---

# Updating the office engines

`crates/papyra-office` renders Word and PowerPoint through two pure-Rust engines from
the storytold Crafting Apps: [WordCraft](https://github.com/storytold/wordcraft) and
[DeckCraft](https://github.com/storytold/deckcraft). Neither is on crates.io, so both
are **git-pinned by rev** in `crates/papyra-office/Cargo.toml`. They move very fast
(each gained 900+ commits in its first twelve days), so a pin goes stale in days and
a blind bump can regress as easily as it improves.

Everything below goes through one tool, `scripts/office-engines.ts`:

```bash
bun run office status                  # how far behind, and which crates moved
bun run office bump [wordcraft|deckcraft|all] [--rev <40-char sha>]
bun run office fidelity                # render the corpus, diff against the baseline
bun run office fidelity --sheets corpus/office/sheets   # plus a contact sheet per file
bun run office fidelity --update       # record the result as the new baseline
```

## The procedure

1. **See what moved.** Run `bun run office status`. It lists, for each engine, how many
   commits behind the pin is and the newest commits in each crate papyra-office
   actually compiles (`doc docx fonts geom layout proof render` for WordCraft;
   `color fonts geom model pptx render text` for DeckCraft). Commits to the editor,
   UI, MCP and CLI crates cannot change our output and are not listed. Read the
   subjects for fixes to known defects (see the table at the end) and for anything
   that sounds like an API change.

2. **Start from a green baseline.** Make sure `crates/papyra-office/fidelity.json` is
   at the current pins. `bun run office fidelity` prints "baseline is at these same
   revs" when it is. If it is not, record one first, *before* bumping, and commit it
   separately, so the bump's diff is only the bump.

3. **Bump one engine at a time.** `bun run office bump wordcraft`, verify, commit; then
   `deckcraft`. Two engines in one commit make a regression impossible to attribute.
   `bump` rewrites every rev for that repo in the manifest, runs
   `cargo update -p <engine>-render` to move `Cargo.lock`, and ends with
   `cargo check -p papyra-office`.

4. **Fix the API breaks in `papyra-office` only.** The surface we use is small and all of
   it is in `crates/papyra-office/src/lib.rs`: `wordcraft_docx::read`,
   `wordcraft_layout::{layout, LayoutCache}`, `wordcraft_render::render_page` (+
   `Rendered::to_straight`), `wordcraft_fonts::FontDb::{global, add_font}`,
   `deckcraft_pptx::{sniff, import}`, `deckcraft_render::{render_slide, RenderOpts}`
   (+ `Image::to_straight`), `deckcraft_fonts::FontDb::{global, add_font}`, and
   `deckcraft_model::Presentation`. If upstream renamed or moved one, follow it. Do not
   patch around an engine bug in our crate; record it instead (step 7).

5. **Run the gates, and read exit codes, not output.**
   ```bash
   cargo test -p papyra-office --color never
   cargo clippy --workspace --all-targets --color never -- -D warnings; echo "exit=$?"
   cargo fmt --all --check
   bun run --filter @build-qube/papyra test:integration   # includes office.test.ts
   ```
   `--color never` and `echo $?` are not decoration. cargo colours its output whenever
   `CARGO_TERM_COLOR` says so, and a `grep '^error'` over coloured output matches
   nothing, so a failing clippy looks clean. That exact mistake once shipped a red
   lint job to CI.

6. **Measure fidelity.** `bun run office fidelity --sheets corpus/office/sheets`. It
   builds the office wasm and the wrapper (skip with `--no-build`), fetches the corpus
   on first run, renders every page of every file, and prints a table plus two
   lists:
   - **better / worse** against the baseline: page counts that moved toward or away
     from the count Office itself saved, pages newly or no longer `blank` (almost
     no ink), `solid` (one non-white colour edge to edge) or `failed`, and files that
     start or stop opening. The command exits 1 if anything got worse.
   - **look at**: the files with a known defect, and what to look for.

   Then **open the contact sheets** in `corpus/office/sheets/` with the Read tool and
   look, at least at every file in either list. Page counts are a proxy; a page can
   keep its count and still lose its pictures. Compare against the previous sheets if
   you kept them (copy the directory before re-running).

7. **Decide, record, commit.**
   - Net better, nothing worse that matters: `bun run office fidelity --update`, and
     commit the manifest, `Cargo.lock` and `fidelity.json` together as
     `chore(office): bump <engine> to <short sha>`. Put the better/worse lists and the
     wasm size (step 8) in the commit body.
   - Something worse: try a nearer rev (`bump <engine> --rev <sha>`, bisecting with
     the `status` commit list), or keep the old pin. Either way, say which file
     regressed and how.
   - A defect fixed or newly found: update its `note` in the `FILES` list in
     `scripts/office-engines.ts` and the table below.

8. **Check the wasm size** after a bump, since it is papyra-office's biggest cost:
   ```bash
   bun run --filter @build-qube/papyra-office-native build:wasm
   gzip -9c packages/office-bindings/papyra-office.wasm32-wasi.wasm | wc -c
   ```
   It was 4.24 MB gzipped at the first pin (1.35 MB code, ~2.9 MB embedded fonts and
   hyphenation data). Report a change over about 100 KB either way. Pass the exact
   file: the directory also holds an unstripped `*.debug.wasm`, and a glob picks up
   both.

9. **Spot-check in a browser** if layout or fonts changed: `bun run --filter
   papyra-demo dev`, open `/components`, and page through the file preview to
   `sample.docx` and `sample.pptx`. The demo needs the wasm build from step 8.

## Why the check runs on wasm, under Node

The native build catalogs whatever fonts the host has installed, so the same `.docx`
paginates differently on two machines, and a baseline recorded on one laptop fails on
the next. wasm has no system fonts at all, so its output depends only on the bytes
and on the fonts we register, which are the four metric-compatible families the demo
loads (Carlito, Caladea, Arimo, Tinos, pinned to a google/fonts commit). That makes
it reproducible, and it is also exactly what a browser runs.

Bun cannot load napi's WASI glue, so `office-engines.ts` hands the rendering to
`scripts/office-fidelity-run.mjs` under Node with `NAPI_RS_FORCE_WASI=error`. Use
`error`, not `1`: `1` only *prefers* WASI and silently falls back to the native addon,
which measures the wrong thing.

## Reading the results

- **`office`** is the page or slide count Office saved in `docProps/app.xml` when the
  file was last saved. It is the reference, not gospel: it reflects the author's fonts
  and printer. `-` means the file has none, or one known to be wrong.
- **`solid` is not always a bug.** It flags any page that is one non-white colour edge
  to edge. `HowWeRefactor.pptx` uses black title slides on purpose (7, 11, 13, 17);
  `alterman_security.pptx` slide 10 is a real failure. The baseline records both, and
  only *changes* are reported, so look at the sheet before calling one a regression.
- **Timings are informational.** They come from one Node process on one machine and
  are not compared.
- The **corpus** is real Office-authored files from Apache POI's `test-data`, pinned to
  one POI commit and fetched into the gitignored `corpus/office`. Never commit them:
  their provenance is mixed, which is why the PDF corpus is fetched the same way.

## Known defects at the first pin

| File | Defect | Engine |
|---|---|---|
| `alterman_security.pptx` | slide 10 renders solid black | DeckCraft |
| `alterman_security.pptx` | slide 16's WMF picture is a placeholder; WMF/EMF are not decoded | both |
| `calendar-ru.docx` | page 1's floating title overlaps the table; 13 pages vs Office's 15 | WordCraft |
| `pcb-paper.docx` | OMML equations draw as empty boxes; 53 pages vs 52 | WordCraft |
| `HowWeRefactor.pptx` | animation builds drawn all at once, so text overlaps | DeckCraft |

Also known, and not visible in the corpus: WordCraft's global decoded-image cache in
`wordcraft-render` is never cleared (a leak in a long-lived server), both engines
embed about 2.9 MB of fonts and hyphenation data with no feature to leave them out,
and the zip size limits (512 MB for docx, 2 GB for pptx) are larger than wasm32 can
hold. Each is worth checking for in `status` output, and worth raising upstream.
