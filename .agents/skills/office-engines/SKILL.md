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
bun run office bump wordcraft --fork BuildQube/wordcraft --rev <sha>   # see "Carrying a fix"
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
   cargo tree -p papyra-office-bindings --target wasm32-wasip1-threads -i js-sys  # must be empty
   ```
   `--color never` and `echo $?` are not decoration. cargo colours its output whenever
   `CARGO_TERM_COLOR` says so, and a `grep '^error'` over coloured output matches
   nothing, so a failing clippy looks clean. That exact mistake once shipped a red
   lint job to CI.

   The last line is the one that bites. Both engines target the browser as
   `wasm32-unknown-unknown`, and their wasm check builds only that. Our wasm is
   WASI, so any `js_sys` call gated on `target_arch = "wasm32"` alone compiles for
   us and then panics at run time ("cannot call wasm-bindgen imported functions on
   non-wasm targets"). WordCraft's clock did exactly this in October 2026, and every
   Word document failed. Native tests cannot see it; `fidelity` does, as a crash.

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
   hyphenation data), and 5.29 MB after WordCraft `f4299ff`. Report a change over about 100 KB either way. Pass the exact
   file: the directory also holds an unstripped `*.debug.wasm`, and a glob picks up
   both.

9. **Spot-check in a browser** if layout or fonts changed: `bun run --filter
   papyra-demo dev`, open `/components`, and page through the file preview to
   `sample.docx` and `sample.pptx`. The demo needs the wasm build from step 8.

## Carrying a fix on a fork

When upstream breaks something only we hit, don't patch around it in
`papyra-office`. Fix it upstream, and pin to the fix while the PR waits:

1. Fork into `BuildQube/<engine>` (`gh repo fork storytold/<engine> --org BuildQube
   --clone=false`). Make one commit on upstream `main`, and push it as a branch.
2. Open the PR from that branch. storytold restricts OAuth apps, so `gh pr create`
   is refused, and a person has to open it from the browser at
   `https://github.com/storytold/<engine>/compare/main...BuildQube:<engine>:<branch>`.
3. `bun run office bump <engine> --fork BuildQube/<engine> --rev <the fix's sha>`.
   Always pass the commit, never a branch. **Don't delete the branch** while
   anything pins it: an unreferenced commit can be garbage-collected, and the pinned
   rev stops fetching.
4. `status` then says the pin is on the fork and lists the commits it carries that
   upstream lacks. Once that list is empty, the fix has merged: a plain
   `bump <engine>` returns to storytold. `bump` warns about any fork commit the new
   rev lacks, so leaving too early is visible.

Active forks:

| Engine | Fork commit | Fix | Upstream PR |
|---|---|---|---|
| WordCraft | `f4299ff` on `BuildQube/wordcraft` `fix/wasi-clock` | browser clock only on `wasm32-unknown-unknown` | to be opened |

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

## Known defects

| File | Defect | Engine |
|---|---|---|
| `alterman_security.pptx` | slide 10 renders solid black | DeckCraft |
| `alterman_security.pptx` | slide 16's WMF picture is a placeholder; WMF/EMF are not decoded | both |
| `calendar-ru.docx` | 16 pages vs Office's 15 (13 before `f4299ff`, which fixed the title overlapping the table) | WordCraft |
| `bug65649.docx` | blank pages 2, 112, 161, 210 at section breaks since `f4299ff`; not checked against Word | WordCraft |
| `HowWeRefactor.pptx` | animation builds drawn all at once, so text overlaps | DeckCraft |

Also known, and not visible in the corpus: WordCraft's global decoded-image cache in
`wordcraft-render` is never cleared (a leak in a long-lived server), both engines
embed about 2.9 MB of fonts and hyphenation data with no feature to leave them out,
and the zip size limits (512 MB for docx, 2 GB for pptx) are larger than wasm32 can
hold. Each is worth checking for in `status` output, and worth raising upstream.
