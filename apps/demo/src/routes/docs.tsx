import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@workspace/ui/components/alert';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@workspace/ui/components/input-group';
import { Spinner } from '@workspace/ui/components/spinner';
import { SearchIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ApiMember } from '../components/docs/ApiMember.js';
import { CommentBody } from '../components/docs/CommentBody.js';
import { type ApiIndex, loadApi, type Reflection } from '../lib/apiModel.js';

/**
 * The `@build-qube/papyra` API reference.
 *
 * Rendered from the TypeDoc model that `packages/docs-gen` extracts from the
 * wrapper's own doc comments, so the reference cannot drift from the source: an
 * export with no TSDoc fails that build rather than shipping a blank entry here.
 *
 * One scrolling page rather than a page per export. 48 exports is small enough that
 * an in-page anchor is the whole navigation story, and it means every `{@link}` in
 * the source resolves to a jump that needs no router round trip — including the ones
 * pointing at nested members like `Document.search`.
 */
export function DocsRoute() {
  const [api, setApi] = useState<ApiIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let live = true;
    loadApi().then(
      (index) => live && setApi(index),
      (e: unknown) =>
        live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  /**
   * Resolves a `{@link}` target or a type reference to a fragment.
   *
   * TypeDoc has already resolved these to ids, so nothing here has to guess from a
   * name — a nested member anchors to `#r<id>` and a top-level export to its own
   * name, which keeps shared links readable for the ones people actually share.
   */
  const hrefFor = useMemo(() => {
    return (target: number | undefined, name: string): string | undefined => {
      if (api && target !== undefined) {
        const node = api.byId.get(target);
        if (node) {
          const owner = api.ownerOf.get(target);
          return owner === target ? `#${node.name}` : `#r${target}`;
        }
      }
      // A reference with no id: only a link if it happens to name an export.
      return api?.topLevel.some((t) => t.name === name)
        ? `#${name}`
        : undefined;
    };
  }, [api]);

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 p-6">
        <Alert variant="destructive" className="h-fit">
          <TriangleAlertIcon />
          <AlertTitle>The API reference could not be loaded</AlertTitle>
          <AlertDescription className="font-mono text-xs">
            {error}
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!api) {
    return (
      <div className="flex min-h-0 flex-1 items-start gap-2 p-6 text-sm text-muted-foreground">
        <Spinner />
        Loading the API reference…
      </div>
    );
  }

  const query = filter.trim().toLowerCase();
  const matches = (node: Reflection): boolean =>
    !query || node.name.toLowerCase().includes(query);

  const groups = api.groups
    .map((group) => ({
      title: group.title,
      members: group.children
        .map((id) => api.byId.get(id))
        .filter((node): node is Reflection => !!node && matches(node)),
    }))
    .filter((group) => group.members.length > 0);

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="API members"
        className="flex w-56 flex-none flex-col border-r bg-card"
      >
        <div className="flex-none border-b p-2">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Filter API members"
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
                {group.members.map((node) => (
                  <li key={node.id}>
                    <a
                      className="block border-l-2 border-transparent px-2.5 py-0.5 font-mono text-xs hover:border-primary hover:bg-muted"
                      href={`#${node.name}`}
                    >
                      {node.name}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {groups.length === 0 && (
            <p className="border-b px-2.5 py-2 text-xs text-muted-foreground">
              No members match “{filter}”.
            </p>
          )}
        </div>
      </nav>

      {/*
       * Padded well past the last entry so a fragment jump can always put its target
       * at the top of the viewport, rather than wherever the page happens to bottom
       * out.
       */}
      <main className="min-w-0 flex-1 overflow-y-auto px-8 pt-6 pb-[60vh]">
        {/* The package README, which is also the npm landing page — so the
            quickstart a reader needs first is the same text a reader gets there,
            and neither can go stale while the other is updated. */}
        <CommentBody hrefFor={hrefFor} parts={api.readme} variant="readme" />
        <p className="mt-4 max-w-[74ch] text-xs text-muted-foreground">
          Everything below is generated from the package's doc comments. Every
          entry links to the line it is declared on.
        </p>
        {groups.map((group) => (
          <div key={group.title}>
            <h2 className="mt-8 border-b pb-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {group.title}
            </h2>
            {group.members.map((node) => (
              <ApiMember hrefFor={hrefFor} key={node.id} node={node} />
            ))}
          </div>
        ))}
      </main>
    </div>
  );
}
