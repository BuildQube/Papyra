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
 * the name, because an item is named `pdf-zoom-bar` and its component is `ZoomBar`.
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

/** The one-liner that installs an item. */
export function installCommand(name: string): string {
  return `npx shadcn@latest add https://buildqube.github.io/Papyra/r/${name}.json`;
}
