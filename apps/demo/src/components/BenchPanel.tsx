import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import { Field, FieldLabel } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { Spinner } from '@workspace/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@workspace/ui/components/table';
import { TriangleAlertIcon } from 'lucide-react';
import { useId, useState } from 'react';
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
  const dpiId = useId();

  async function run() {
    setRunning(true);
    setError(null);
    setResults(null);
    try {
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
    <Card className="h-fit w-full max-w-3xl">
      <CardHeader className="grid-cols-[1fr_auto] items-center">
        <CardTitle>Benchmark</CardTitle>
        <div className="col-start-2 flex items-center gap-3">
          <Field orientation="horizontal" className="w-auto">
            <FieldLabel htmlFor={dpiId}>DPI</FieldLabel>
            <Input
              id={dpiId}
              type="number"
              className="w-20 tabular-nums"
              min={24}
              max={400}
              step={6}
              value={dpi}
              onChange={(e) => setDpi(Number(e.target.value))}
            />
          </Field>
          <Button onClick={run} disabled={running}>
            {running && <Spinner data-icon="inline-start" />}
            {running ? 'Running…' : `Run on ${name}`}
          </Button>
        </div>
      </CardHeader>

      {(error || results) && (
        <CardContent className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>The benchmark did not finish</AlertTitle>
              <AlertDescription className="font-mono text-xs">
                {error}
              </AlertDescription>
            </Alert>
          )}

          {results && (
            <Table className="tabular-nums">
              <TableHeader>
                <TableRow>
                  <TableHead>engine</TableHead>
                  <TableHead>pages</TableHead>
                  <TableHead>total</TableHead>
                  <TableHead>ms/page</TableHead>
                  <TableHead>first page</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <TableRow key={r.engine}>
                    <TableCell>{r.engine}</TableCell>
                    <TableCell>{r.pages}</TableCell>
                    <TableCell>{r.totalMs.toFixed(0)}ms</TableCell>
                    <TableCell>{r.msPerPage.toFixed(2)}</TableCell>
                    <TableCell>{r.firstPageMs.toFixed(1)}ms</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      )}

      {papyra && pdfjs && (
        <CardFooter className="flex-wrap gap-1.5 text-sm text-muted-foreground">
          papyra is
          <Badge>{(pdfjs.msPerPage / papyra.msPerPage).toFixed(2)}x</Badge>
          pdf.js on throughput,
          <Badge>{(pdfjs.firstPageMs / papyra.firstPageMs).toFixed(2)}x</Badge>
          on first page.
        </CardFooter>
      )}
    </Card>
  );
}
