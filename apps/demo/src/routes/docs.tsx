import { useEffect, useMemo, useState } from 'react';
import { ApiMember } from '../components/docs/ApiMember.js';
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
      <div className="workspace">
        <p className="error">{error}</p>
      </div>
    );
  }
  if (!api) {
    return (
      <div className="workspace">
        <p className="api-loading muted">Loading the API reference…</p>
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
    <div className="workspace">
      <nav aria-label="API members" className="sidebar api-nav">
        <div className="api-filter">
          <input
            aria-label="Filter API members"
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            type="search"
            value={filter}
          />
        </div>
        <div className="panel">
          {groups.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <ul>
                {group.members.map((node) => (
                  <li key={node.id}>
                    <a href={`#${node.name}`}>{node.name}</a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {groups.length === 0 && (
            <p className="panel-note muted">No members match “{filter}”.</p>
          )}
        </div>
      </nav>

      <main className="api-content">
        <div className="api-intro">
          <h1>@build-qube/papyra</h1>
          <p className="muted">
            Generated from the package's own doc comments. Every entry links to
            the line it is declared on.
          </p>
        </div>
        {groups.map((group) => (
          <div key={group.title}>
            <h2 className="api-group">{group.title}</h2>
            {group.members.map((node) => (
              <ApiMember hrefFor={hrefFor} key={node.id} node={node} />
            ))}
          </div>
        ))}
      </main>
    </div>
  );
}
