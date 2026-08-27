/**
 * The slice of TypeDoc's serialised model the reference actually renders.
 *
 * Hand-written rather than pulled from `typedoc`'s own types: that package is a
 * devDependency of `packages/docs-gen` and pins TypeScript 5 (TypeDoc cannot run on
 * this repo's TypeScript 7 — see TypeStrong/typedoc#3098), so pulling its types into
 * the demo would drag a second compiler into the app's typecheck for no benefit.
 *
 * Every kind below was enumerated from the generated model, not guessed. The union
 * is closed on purpose — a new one shows up as a visible `unknown` in the output
 * rather than silently rendering nothing.
 */

/** TypeDoc's `ReflectionKind` bit flags, for the kinds this API surface produces. */
export const Kind = {
  Variable: 32,
  Function: 64,
  Class: 128,
  Interface: 256,
  Constructor: 512,
  Property: 1024,
  Method: 2048,
  CallSignature: 4096,
  ConstructorSignature: 16384,
  Parameter: 32768,
  TypeLiteral: 65536,
  TypeParameter: 131072,
  Accessor: 262144,
  GetSignature: 524288,
  TypeAlias: 2097152,
} as const;

/** One piece of a doc comment. `inline-tag` is `{@link ...}`. */
export type CommentPart =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'inline-tag'; tag: string; text: string; target?: number };

export interface BlockTag {
  /** `'@example'`, `'@returns'`, and so on — the `@` is included. */
  tag: string;
  content: CommentPart[];
}

export interface Comment {
  summary?: CommentPart[];
  blockTags?: BlockTag[];
}

export type ApiType =
  | { type: 'intrinsic'; name: string }
  | { type: 'literal'; value: string | number | boolean | null }
  | {
      type: 'reference';
      name: string;
      /** Set when the target is documented here, which is what makes it a link. */
      target?: number | { qualifiedName?: string };
      typeArguments?: ApiType[];
    }
  | { type: 'array'; elementType: ApiType }
  | { type: 'union'; types: ApiType[] }
  | { type: 'tuple'; elements?: ApiType[] }
  | { type: 'typeOperator'; operator: string; target: ApiType }
  | { type: 'reflection'; declaration: Reflection };

export interface Source {
  /** Repo-relative, courtesy of TypeDoc's `basePath`. */
  fileName: string;
  line: number;
}

export interface Flags {
  isOptional?: boolean;
  isReadonly?: boolean;
  isStatic?: boolean;
  isRest?: boolean;
}

export interface Reflection {
  id: number;
  name: string;
  kind: number;
  variant?: string;
  flags?: Flags;
  comment?: Comment;
  sources?: Source[];
  children?: Reflection[];
  /** Present on functions and methods; the comment usually lives here, not above. */
  signatures?: Reflection[];
  /** Accessors carry their comment on the getter. */
  getSignature?: Reflection;
  parameters?: Reflection[];
  typeParameters?: Reflection[];
  type?: ApiType;
  defaultValue?: string;
  /** Set on `extends` clauses, e.g. `RenderHandle extends JobHandle<RenderedPage>`. */
  extendedTypes?: ApiType[];
  groups?: Group[];
}

export interface Group {
  title: string;
  children: number[];
}

export interface ApiProject extends Reflection {
  children?: Reflection[];
  groups?: Group[];
  /** The package README, via TypeDoc's `readme` option. Same token stream as a comment. */
  readme?: CommentPart[];
}

/** A project plus the lookups the renderer needs to resolve `{@link}` targets. */
export interface ApiIndex {
  project: ApiProject;
  /** Every reflection by id, including nested members. */
  byId: Map<number, Reflection>;
  /** Only top-level exports — the ones that have a page of their own. */
  topLevel: Reflection[];
  /** Id of the top-level export a nested member belongs to, so links can anchor. */
  ownerOf: Map<number, number>;
  groups: Group[];
  /** The quickstart that opens the page. */
  readme?: CommentPart[];
}

export function buildIndex(project: ApiProject): ApiIndex {
  const byId = new Map<number, Reflection>();
  const ownerOf = new Map<number, number>();
  const topLevel = project.children ?? [];

  const visit = (node: Reflection, owner: number): void => {
    byId.set(node.id, node);
    ownerOf.set(node.id, owner);
    for (const child of members(node)) visit(child, owner);
  };
  for (const child of topLevel) visit(child, child.id);

  return {
    project,
    byId,
    topLevel,
    ownerOf,
    groups: project.groups ?? [],
    readme: project.readme,
  };
}

/** Every reflection nested under `node`, whatever slot TypeDoc parked it in. */
function members(node: Reflection): Reflection[] {
  return [
    ...(node.children ?? []),
    ...(node.signatures ?? []),
    ...(node.parameters ?? []),
    ...(node.typeParameters ?? []),
    ...(node.getSignature ? [node.getSignature] : []),
  ];
}

/**
 * The comment for a reflection, wherever it actually lives.
 *
 * A function's prose sits on its call signature and an accessor's on its getter, so
 * reading `node.comment` alone silently renders half the API as undocumented.
 */
export function commentOf(node: Reflection): Comment | undefined {
  return (
    node.comment ?? node.signatures?.[0]?.comment ?? node.getSignature?.comment
  );
}

/**
 * A key for a type in a rendered list, derived from the type itself.
 *
 * Unions and `extends` clauses arrive as bare arrays with no ids, and their position
 * is not a key — the whole model is regenerated on every build. Two members of one
 * union are distinct types by construction, so their own shape identifies them.
 */
export function typeKey(type: ApiType): string {
  switch (type.type) {
    case 'intrinsic':
      return type.name;
    case 'literal':
      return `lit:${String(type.value)}`;
    case 'reference':
      return `${type.name}<${(type.typeArguments ?? []).map(typeKey).join(',')}>`;
    case 'array':
      return `${typeKey(type.elementType)}[]`;
    case 'union':
      return type.types.map(typeKey).join('|');
    case 'tuple':
      return `[${(type.elements ?? []).map(typeKey).join(',')}]`;
    case 'typeOperator':
      return `${type.operator} ${typeKey(type.target)}`;
    case 'reflection':
      return `obj:${type.declaration.id}`;
    default:
      return 'unknown';
  }
}

/** A stable URL fragment for a top-level export. */
export function slugOf(node: Reflection): string {
  return node.name;
}

const GITHUB_BLOB = 'https://github.com/BuildQube/Papyra/blob/main/';

/** Link to the exact line this member is declared on. */
export function sourceUrl(source: Source): string {
  return `${GITHUB_BLOB}${source.fileName}#L${source.line}`;
}

/** Fetch and index the generated model. */
export async function loadApi(): Promise<ApiIndex> {
  const url = `${import.meta.env.BASE_URL}papyra-api.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `could not load the API model (${res.status}). Run \`bun run --filter papyra-docs-gen build\`.`,
    );
  }
  return buildIndex((await res.json()) as ApiProject);
}
