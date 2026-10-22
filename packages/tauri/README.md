# @build-qube/papyra-tauri

A Tauri engine for papyra's PDF viewer: documents are parsed and rendered by papyra in
the app's host process, through the `tauri-plugin-papyra` crate.

A Tauri app's WebView is never cross-origin isolated on Android or iOS, so papyra's
wasm build cannot run there. This engine does not need it: the Rust side renders on
the device's real cores, and the WebView only paints.

Installing it, wiring `tauri-plugin-papyra` into the app, and keeping papyra's
wasm out of the bundle are in the [Tauri guide](https://buildqube.github.io/Papyra/docs/guides/tauri).

## Pages and lifetimes

Pages travel over a `papyra://` protocol, as PNG by default. `new TauriEngine({
format: 'rgba' })` sends raw pixels instead: no encode or decode, four times the
bytes. Which is faster depends on the device.

Documents stay in the host until closed. The viewer's store and file preview close
what they open; if you call the engine yourself, `await engine.close(doc)` — it
rejects if the host could not release the document. When a WebView loads a page —
a reload, HMR, the app restarting its UI — the host drops every document that
WebView had open, since nothing on the new page could close them.
