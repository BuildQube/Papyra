# @build-qube/papyra-office-native

**Experimental.** The Word and PowerPoint renderer behind
[papyra](https://www.npmjs.com/package/@build-qube/papyra): Node-API bindings over
[WordCraft](https://github.com/storytold/wordcraft) and
[DeckCraft](https://github.com/storytold/deckcraft), pure-Rust engines
that lay out and draw `.docx` and `.pptx` pages, built as a native addon per platform
and as a wasm module for the browser.

**Install it beside [`@build-qube/papyra`](https://www.npmjs.com/package/@build-qube/papyra),
and import that instead.** This package is the optional peer that
`@build-qube/papyra/office` loads on its first open. Its own shape is not a stable
public API.

```bash
npm install @build-qube/papyra @build-qube/papyra-office-native
```

```ts
import { paintToCanvas } from '@build-qube/papyra/core';
import { officeEngine } from '@build-qube/papyra/office';

await officeEngine.addFont(carlito); // metric-compatible with Calibri
const doc = await officeEngine.open(file);
paintToCanvas(await officeEngine.render(doc, 0, { fitWidth: 1200 }).promise, canvas);
```

- **What it renders.** Word documents (`.docx`, `.docm`, `.dotx`, `.dotm`), paginated
  with Word's page breaks, headers and footers, and PowerPoint decks (`.pptx`,
  `.potx`, `.ppsx` and their macro-enabled twins). Pages only: no text, links or
  outline. A real-world file may still lay out differently from Office.
- **Fonts decide pagination.** A browser has no system fonts, so register
  metric-compatible substitutes — Carlito, Caladea, Arimo and Tinos, for Calibri,
  Cambria, Arial and Times New Roman — with `officeEngine.addFont` before opening, or
  every line break moves.
- **Its own wasm.** A separate module from papyra's PDF one, about 5.7 MB gzipped as
  measured at the current engine pin, so a PDF-only app never downloads it. Like the
  PDF build, it needs a cross-origin-isolated page.
- **A panic in wasm is fatal** to this module until the page reloads; papyra's PDF
  rendering keeps working.

The platform binaries (`@build-qube/papyra-office-native-darwin-arm64`,
`-linux-x64-gnu`, `-wasm32-wasi`, …) are optional dependencies of this package; your
package manager installs the one that matches.

Isolation, the viewer integration and the rest: the
[Engines section of the papyra README](https://github.com/BuildQube/Papyra#engines).
