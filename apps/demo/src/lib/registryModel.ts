import {
  type ApiProject,
  type Comment,
  commentOf,
  Kind,
  type Reflection,
} from './apiModel.js';

/** One item as `shadcn build` emitted it, read from the served registry index. */
export interface RegistryItem {
  name: string;
  type: string;
  title?: string;
  description?: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files?: { path: string; type: string }[];
  /** Set on renderers, so the file preview picker can list them without a list. */
  meta?: {
    fileRenderer?: {
      /** The renderer's id: what an `allow` list names it by. */
      id: string;
      /** The descriptor's export name, for the generated setup file. */
      export: string;
      /** What the format is called. */
      label: string;
      /** Matches by name rather than bytes, so it belongs last in the list. */
      byName?: boolean;
    };
  };
}

/** A single documented prop, flattened for the table. */
export interface PropRow {
  name: string;
  /** Rendered from the TypeDoc type, so links resolve like they do in /docs. */
  reflection: Reflection;
  optional: boolean;
  comment?: Comment;
}

/** An item, its docs and its props, joined for rendering. */
export interface RegistryEntry {
  item: RegistryItem;
  /** The exported symbol the item is named after, if the model has one. */
  symbol?: Reflection;
  /** The `*Props` interface's members, empty for libs and hooks without one. */
  props: PropRow[];
  /** Where the item's file lives, for the "view source" link. */
  file?: string;
}

/**
 * The registry index and the TypeDoc model are two views of the same 21 items, and
 * neither alone is enough: the index knows what to install and what it depends on,
 * the model knows what the props are. They are joined on the file path rather than on
 * the name, because an item is named `viewer-zoom-bar` and its component is `ZoomBar`.
 */
export interface RegistryIndex {
  entries: RegistryEntry[];
  byName: Map<string, RegistryEntry>;
}

/** TypeDoc's `expand` strategy gives one module per file; flatten to declarations. */
function declarations(project: ApiProject): Reflection[] {
  const out: Reflection[] = [];
  for (const module of project.children ?? []) {
    for (const child of module.children ?? []) {
      out.push({ ...child, sources: child.sources ?? module.sources });
    }
  }
  return out;
}

function propsOf(decls: Reflection[], file: string): PropRow[] {
  const iface = decls.find(
    (d) => d.name.endsWith('Props') && d.sources?.[0]?.fileName.endsWith(file),
  );
  return (iface?.children ?? []).map((child) => ({
    name: child.name,
    reflection: child,
    optional: child.flags?.isOptional === true,
    comment: commentOf(child),
  }));
}

/** Fetch both models and join them. */
export async function loadRegistry(): Promise<RegistryIndex> {
  const base = import.meta.env.BASE_URL;
  const [indexRes, modelRes] = await Promise.all([
    fetch(`${base}r/registry.json`),
    fetch(`${base}papyra-registry-api.json`),
  ]);

  if (!indexRes.ok) {
    throw new Error(
      `could not load the registry (${indexRes.status}). Run \`bun run --filter @workspace/pdf-viewer build:registry\`.`,
    );
  }
  if (!modelRes.ok) {
    throw new Error(
      `could not load the registry API model (${modelRes.status}). Run \`bun run --filter papyra-docs-gen build\`.`,
    );
  }

  const items = ((await indexRes.json()) as { items: RegistryItem[] }).items;
  const decls = declarations((await modelRes.json()) as ApiProject);

  const entries: RegistryEntry[] = items.map((item) => {
    const file = item.files?.[0]?.path;
    const mine = file
      ? decls.filter((d) => d.sources?.[0]?.fileName.endsWith(file))
      : [];
    // The item's headline export. A `*Props` interface names it exactly — `ZoomBarProps`
    // means `ZoomBar` — which beats guessing, because a file may also export a context
    // or a constant that happens to come first.
    const named = mine.find((d) => d.name.endsWith('Props'))?.name.slice(0, -5);
    return {
      item,
      symbol:
        (named ? mine.find((d) => d.name === named) : undefined) ??
        mine.find((d) => d.kind === Kind.Function) ??
        mine.find((d) => !d.name.endsWith('Props')),
      props: file ? propsOf(decls, file) : [],
      file,
    };
  });

  return {
    entries,
    byName: new Map(entries.map((e) => [e.item.name, e])),
  };
}

/** The page anchor of the setup step, which the file preview picker links back to. */
export const SETUP_ANCHOR = 'setup';

/** The namespace this registry is installed under. */
export const NAMESPACE = '@papyra';

/**
 * Where the built items are served. `{name}` is shadcn's placeholder for an item and
 * `{style}` for the project's style, which is what picks the Base UI or the Radix
 * build — see `build-registry.ts`, which writes a directory per style.
 */
export const REGISTRY_URL =
  'https://buildqube.github.io/Papyra/r/{style}/{name}.json';

/**
 * The one-time setup that makes `@papyra/<item>` resolvable: it writes the namespace
 * into the project's `components.json`. Until the namespace is listed in shadcn's
 * own directory, this step is what the short names cost.
 */
export const SETUP_COMMAND = `npx shadcn@latest registry add ${NAMESPACE}=${REGISTRY_URL}`;

/** The one-liner that installs one or more items by namespaced name. */
export function installCommand(...names: string[]): string {
  return `npx shadcn@latest add ${names.map((n) => `${NAMESPACE}/${n}`).join(' ')}`;
}

/** An item name from a sibling dependency URL, or `undefined` for an official one. */
export function siblingName(dep: string): string | undefined {
  if (!dep.startsWith('http')) return undefined;
  return (dep.split('/').pop() ?? dep).replace(/\.json$/, '');
}

/** Everything an install of these items brings with it. */
export interface Footprint {
  /** npm packages, across every item installed. */
  npm: string[];
  /** Official shadcn components, by name. */
  shadcn: string[];
  /** Items from this registry, the named ones included. */
  items: string[];
}

/**
 * Walk `registryDependencies` from `names` to everything `shadcn add` would install,
 * which is what a reader choosing formats actually wants to know — `file-preview-pdf`
 * declares papyra itself, but `file-preview-image` gets lucide only through the zoom
 * bar it depends on.
 */
export function footprint(
  names: readonly string[],
  byName: ReadonlyMap<string, RegistryEntry>,
): Footprint {
  const items = new Set<string>();
  const npm = new Set<string>();
  const shadcn = new Set<string>();
  const queue = [...names];
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (items.has(name)) continue;
    const item = byName.get(name)?.item;
    if (!item) continue;
    items.add(name);
    // `@build-qube/papyra@^0.3.0` is the package `@build-qube/papyra`.
    for (const dep of item.dependencies ?? []) {
      npm.add(dep.replace(/(.)@[^@/]*$/, '$1'));
    }
    for (const dep of item.registryDependencies ?? []) {
      const sibling = siblingName(dep);
      if (sibling) queue.push(sibling);
      else shadcn.add(dep);
    }
  }
  const sorted = (set: Set<string>) => [...set].sort();
  return { npm: sorted(npm), shadcn: sorted(shadcn), items: sorted(items) };
}
