import { backend, currentRuntime } from '@build-qube/papyra';
import { Link, Outlet, useSearch } from '@tanstack/react-router';
import { useDocument, useFileParam } from '../lib/documentContext.js';

/**
 * Shell for every route: identity, the file picker, and the nav.
 *
 * Timings are deliberately *not* here — each route measures a different pipeline and
 * renders its own status line in the same place, so the two read as a comparison.
 */
export function RootShell() {
  const { loaded, error, load } = useDocument();
  // Loose search access: typing it against the root route would import the router,
  // which imports this file.
  const { file } = useSearch({ strict: false }) as { file?: string };
  useFileParam(file);

  return (
    <div className="app">
      <header className="topbar">
        <h1>papyra</h1>
        <span className="badge">{currentRuntime()}</span>
        <span className="badge">{backend()}</span>

        <nav className="nav">
          <Link to="/" search={(prev) => prev} activeOptions={{ exact: true }}>
            viewer
          </Link>
          <Link to="/export" search={(prev) => prev}>
            export
          </Link>
          <Link to="/bench" search={(prev) => prev}>
            bench
          </Link>
        </nav>

        <label className="file">
          Open PDF
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void load(picked);
            }}
          />
        </label>

        {loaded && <span className="muted">{loaded.name}</span>}
      </header>

      {error && <p className="error">{error}</p>}

      {loaded ? <Outlet /> : <Dropzone onFile={load} />}
    </div>
  );
}

function Dropzone({ onFile }: { onFile: (file: File) => void }) {
  return (
    <section
      aria-label="Drop a PDF to open it"
      className="dropzone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <p>Drop a PDF here, or use “Open PDF”.</p>
      <p className="muted">
        Rendered by hayro compiled to wasm, running in this tab.
      </p>
    </section>
  );
}
