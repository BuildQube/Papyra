import { PagePreview } from '@workspace/pdf-viewer/components/pdf-page-preview';
import { PdfPreviewDialog } from '@workspace/pdf-viewer/components/pdf-preview-dialog';
import { ThumbnailPicker } from '@workspace/pdf-viewer/components/pdf-thumbnail-picker';
import { PdfViewer } from '@workspace/pdf-viewer/components/pdf-viewer';
import { PdfViewerBasic } from '@workspace/pdf-viewer/components/pdf-viewer-basic';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { CopyButton } from '@workspace/ui/components/copy-button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@workspace/ui/components/input-group';
import { Spinner } from '@workspace/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@workspace/ui/components/table';
import { SearchIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { BlockPreview } from '../components/BlockPreview.js';
import { CommentBody } from '../components/docs/CommentBody.js';
import { TypeSignature } from '../components/docs/TypeSignature.js';
import { sourceUrl } from '../lib/apiModel.js';
import { usePreviewDocument } from '../lib/previewDocument.js';
import {
  installCommand,
  loadRegistry,
  type RegistryEntry,
  type RegistryIndex,
} from '../lib/registryModel.js';

/** The order the groups read in: what a page is made of, then what drives it. */
const GROUPS: { title: string; type: string }[] = [
  { title: 'Blocks', type: 'registry:block' },
  { title: 'Components', type: 'registry:component' },
  { title: 'Hooks', type: 'registry:hook' },
  { title: 'Libraries', type: 'registry:lib' },
];

/**
 * The papyra component registry.
 *
 * Everything on this page is generated from the two artifacts the build already
 * produces — `r/registry.json` for what installs and what it depends on, and the
 * TypeDoc model for the props. Neither is written by hand here, so a component whose
 * props change cannot leave a stale table behind: the docs build fails first.
 */
export function ComponentsRoute() {
  const [registry, setRegistry] = useState<RegistryIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let live = true;
    loadRegistry().then(
      (index) => live && setRegistry(index),
      (e: unknown) =>
        live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const groups = useMemo(() => {
    if (!registry) return [];
    const query = filter.trim().toLowerCase();
    return GROUPS.map((group) => ({
      title: group.title,
      entries: registry.entries.filter(
        (e) =>
          e.item.type === group.type &&
          (!query ||
            e.item.name.includes(query) ||
            (e.item.title ?? '').toLowerCase().includes(query)),
      ),
    })).filter((group) => group.entries.length > 0);
  }, [registry, filter]);

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 p-6">
        <Alert variant="destructive" className="h-fit">
          <TriangleAlertIcon />
          <AlertTitle>The registry could not be loaded</AlertTitle>
          <AlertDescription className="font-mono text-xs">
            {error}
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!registry) {
    return (
      <div className="flex min-h-0 flex-1 items-start gap-2 p-6 text-sm text-muted-foreground">
        <Spinner />
        Loading the registry…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Registry items"
        className="flex w-56 flex-none flex-col border-r bg-card"
      >
        <div className="flex-none border-b p-2">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Filter registry items"
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              type="search"
              value={filter}
            />
          </InputGroup>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {groups.map((group) => (
            <section key={group.title}>
              <h3 className="px-2.5 pt-3 pb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
                {group.title}
              </h3>
              <ul>
                {group.entries.map((entry) => (
                  <li key={entry.item.name}>
                    <a
                      className="block border-l-2 border-transparent px-2.5 py-0.5 font-mono text-xs hover:border-primary hover:bg-muted"
                      href={`#${entry.item.name}`}
                    >
                      {entry.item.name}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {groups.length === 0 && (
            <p className="border-b px-2.5 py-2 text-xs text-muted-foreground">
              No items match “{filter}”.
            </p>
          )}
        </div>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto px-8 pt-6 pb-[60vh]">
        <div className="max-w-[74ch]">
          <h1 className="font-heading mb-2.5 font-mono text-[22px] tracking-[0.01em]">
            Components
          </h1>
          <p className="text-sm text-muted-foreground">
            A shadcn registry: every item below installs into your own project
            as source, with its dependencies resolved for you. They are the same
            files this demo is built from.
          </p>
          <Alert className="mt-4">
            <TriangleAlertIcon />
            <AlertTitle>These need papyra 0.2.0</AlertTitle>
            <AlertDescription>
              The components call <code>pageLabels()</code>,{' '}
              <code>links()</code> and <code>fingerprint</code>, which the
              published 0.1.0 does not have. Until 0.2.0 ships an install stops
              at <code>notarget</code>.
            </AlertDescription>
          </Alert>
        </div>

        {groups.map((group) => (
          <div key={group.title}>
            <h2 className="mt-8 border-b pb-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {group.title}
            </h2>
            {group.entries.map((entry) => (
              <Item entry={entry} key={entry.item.name} />
            ))}
          </div>
        ))}
      </main>
    </div>
  );
}

/**
 * Nothing on this page is anchored by TypeDoc id, so every `{@link}` renders as plain
 * text. Resolving them would mean linking a consumer to a symbol they may not have
 * installed — the wrapper's own reference at /docs is the place for that.
 */
const noLinks = () => undefined;

/**
 * A block, running.
 *
 * Only blocks get one: they are the items that stand alone, and a `PageSurface` or a
 * `Highlights` overlay outside a page is a rectangle, not a demonstration.
 */
function Preview({ name }: { name: string }) {
  const doc = usePreviewDocument();
  if (!doc) return null;

  switch (name) {
    case 'pdf-viewer':
      return (
        <BlockPreview>
          <PdfViewer doc={doc} />
        </BlockPreview>
      );
    case 'pdf-viewer-basic':
      return (
        <BlockPreview>
          <PdfViewerBasic className="flex-1" doc={doc} />
        </BlockPreview>
      );
    case 'pdf-page-preview':
      return (
        <BlockPreview height="h-auto">
          {/* Three at once, which is the case this exists for. */}
          <div className="flex flex-wrap gap-4 p-4">
            {[0, 1, 2].map((page) => (
              <PagePreview
                className="w-40 rounded-sm shadow-md"
                doc={doc}
                key={page}
                page={Math.min(page, doc.pageCount - 1)}
                width={240}
              />
            ))}
          </div>
        </BlockPreview>
      );
    case 'pdf-thumbnail-picker':
      return (
        <BlockPreview height="h-80">
          <ThumbnailPicker className="flex-1" columns={4} doc={doc} />
        </BlockPreview>
      );
    case 'pdf-preview-dialog':
      return (
        <BlockPreview height="h-auto">
          <div className="p-4">
            <PdfPreviewDialog
              description={`${doc.pageCount} pages`}
              doc={doc}
              title="sample.pdf"
              trigger={<Button variant="outline">Preview document</Button>}
            />
          </div>
        </BlockPreview>
      );
    default:
      return null;
  }
}

function Item({ entry }: { entry: RegistryEntry }) {
  const { item, symbol, props } = entry;
  const source = symbol?.sources?.[0];
  const command = installCommand(item.name);

  return (
    <section className="scroll-mt-4 border-b py-5" id={item.name}>
      <header className="flex flex-wrap items-baseline gap-2.5">
        <h3 className="font-mono text-base">
          <a className="hover:text-primary" href={`#${item.name}`}>
            {item.name}
          </a>
        </h3>
        {symbol && <Badge variant="outline">{symbol.name}</Badge>}
        {source && (
          <a
            className="ml-auto font-mono text-xs text-muted-foreground hover:text-primary"
            href={sourceUrl(source)}
            rel="noreferrer"
            target="_blank"
          >
            {source.fileName.replace('packages/pdf-viewer/src/', '')}:
            {source.line}
          </a>
        )}
      </header>

      {item.description && (
        <p className="mt-2 max-w-[74ch] text-sm text-muted-foreground">
          {item.description}
        </p>
      )}

      {item.type === 'registry:block' && <Preview name={item.name} />}

      <div className="mt-3 flex max-w-[74ch] items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
          {command}
        </code>
        <CopyButton
          label={`Copy the install command for ${item.name}`}
          value={command}
        />
      </div>

      {(item.dependencies?.length || item.registryDependencies?.length) && (
        <div className="mt-2.5 flex max-w-[74ch] flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Pulls in
          {item.dependencies?.map((dep) => (
            <Badge key={dep} variant="secondary">
              {dep}
            </Badge>
          ))}
          {item.registryDependencies?.map((dep) => (
            <Badge key={dep} variant="outline">
              {/* A sibling is named by URL; show the item, not the address. */}
              {dep.startsWith('http')
                ? (dep.split('/').pop() ?? dep).replace('.json', '')
                : dep}
            </Badge>
          ))}
        </div>
      )}

      {symbol && (
        <CommentBody
          className="mt-3"
          hrefFor={noLinks}
          parts={symbol.comment?.summary}
        />
      )}

      {props.length > 0 && (
        <div className="mt-3 max-w-[74ch] overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">Prop</TableHead>
                <TableHead className="w-48">Type</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.map((prop) => (
                <TableRow key={prop.name}>
                  <TableCell className="align-top font-mono text-xs">
                    {prop.name}
                    {prop.optional && (
                      <span className="text-muted-foreground">?</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs">
                    <TypeSignature
                      hrefFor={noLinks}
                      type={prop.reflection.type}
                    />
                  </TableCell>
                  <TableCell className="align-top text-xs whitespace-normal">
                    <CommentBody
                      className="max-w-none"
                      hrefFor={noLinks}
                      parts={prop.comment?.summary}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
