import { useState } from 'react';
import { type BenchResult, benchPapyra, benchPdfjs } from '../lib/bench.js';

interface Props {
  bytes: Uint8Array;
  name: string;
}

export function BenchPanel({ bytes, name }: Props) {
  const [results, setResults] = useState<BenchResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [dpi, setDpi] = useState(150);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResults(null);
    try {
      // Warm both engines so we compare steady state, not first-call compilation.
      await benchPapyra(bytes, dpi);
      await benchPdfjs(bytes, dpi);
      const papyra = await benchPapyra(bytes, dpi);
      const pdfjs = await benchPdfjs(bytes, dpi);
      setResults([papyra, pdfjs]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const papyra = results?.find((r) => r.engine === 'papyra');
  const pdfjs = results?.find((r) => r.engine === 'pdf.js');

  return (
    <section className="bench">
      <header>
        <h2>Benchmark</h2>
        <label>
          DPI
          <input
            type="number"
            min={24}
            max={400}
            step={6}
            value={dpi}
            onChange={(e) => setDpi(Number(e.target.value))}
          />
        </label>
        <button type="button" onClick={run} disabled={running}>
          {running ? 'Running…' : `Run on ${name}`}
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      {results && (
        <table>
          <thead>
            <tr>
              <th>engine</th>
              <th>pages</th>
              <th>total</th>
              <th>ms/page</th>
              <th>first page</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.engine}>
                <td>{r.engine}</td>
                <td>{r.pages}</td>
                <td>{r.totalMs.toFixed(0)}ms</td>
                <td>{r.msPerPage.toFixed(2)}</td>
                <td>{r.firstPageMs.toFixed(1)}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {papyra && pdfjs && (
        <p className="verdict">
          papyra is{' '}
          <strong>{(pdfjs.msPerPage / papyra.msPerPage).toFixed(2)}x</strong>{' '}
          pdf.js on throughput,{' '}
          <strong>
            {(pdfjs.firstPageMs / papyra.firstPageMs).toFixed(2)}x
          </strong>{' '}
          on first page.
        </p>
      )}
    </section>
  );
}
