import { BenchPanel } from '../components/BenchPanel.js';
import { useDocument } from '../lib/documentContext.js';

/** papyra vs pdf.js on the open document. Its own route now — it needs the room. */
export function BenchRoute() {
  const { loaded } = useDocument();
  if (!loaded) return null;
  return (
    <main className="flex min-h-0 flex-1 justify-center overflow-y-auto p-6">
      <BenchPanel bytes={loaded.bytes} name={loaded.name} />
    </main>
  );
}
