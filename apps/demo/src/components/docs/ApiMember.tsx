import { Badge } from '@workspace/ui/components/badge';
import {
  type BlockTag,
  commentOf,
  Kind,
  type Reflection,
  sourceUrl,
  typeKey,
} from '../../lib/apiModel.js';
import { CommentBody } from './CommentBody.js';
import { TypeSignature } from './TypeSignature.js';

type HrefFor = (target: number | undefined, name: string) => string | undefined;

const KIND_LABEL: Record<number, string> = {
  [Kind.Class]: 'class',
  [Kind.Interface]: 'interface',
  [Kind.TypeAlias]: 'type',
  [Kind.Variable]: 'const',
  [Kind.Function]: 'function',
  [Kind.Property]: 'property',
  [Kind.Method]: 'method',
  [Kind.Accessor]: 'getter',
  [Kind.Constructor]: 'constructor',
};

/** The signature that carries a member's type: a call signature, or a getter's. */
function signaturesOf(node: Reflection): Reflection[] {
  if (node.signatures?.length) return node.signatures;
  if (node.getSignature) return [node.getSignature];
  return [];
}

function Params({
  params,
  hrefFor,
}: {
  params: readonly Reflection[] | undefined;
  hrefFor: HrefFor;
}) {
  return (
    <>
      <span className="text-muted-foreground">(</span>
      {params?.map((param, i) => (
        <span key={param.id}>
          {i > 0 && <span className="text-muted-foreground">, </span>}
          <span className="text-foreground">{param.name}</span>
          {param.flags?.isOptional && (
            <span className="text-muted-foreground">?</span>
          )}
          <span className="text-muted-foreground">: </span>
          <TypeSignature hrefFor={hrefFor} type={param.type} />
        </span>
      ))}
      <span className="text-muted-foreground">)</span>
    </>
  );
}

/** `@example` blocks, and any other block tag worth surfacing. */
function BlockTags({
  tags,
  hrefFor,
}: {
  tags: readonly BlockTag[] | undefined;
  hrefFor: HrefFor;
}) {
  const shown = tags?.filter((t) => t.tag !== '@internal');
  if (!shown?.length) return null;
  return (
    <>
      {shown.map((tag) => (
        <div className="my-2.5" key={tag.tag}>
          <Badge variant="secondary" className="mb-0.5">
            {tag.tag.replace('@', '')}
          </Badge>
          <CommentBody hrefFor={hrefFor} parts={tag.content} />
        </div>
      ))}
    </>
  );
}

/** Documentation for parameters that carry their own prose. */
function ParamDocs({
  params,
  hrefFor,
}: {
  params: readonly Reflection[] | undefined;
  hrefFor: HrefFor;
}) {
  const documented = params?.filter((p) => p.comment?.summary?.length);
  if (!documented?.length) return null;
  return (
    <dl className="my-2 max-w-[74ch]">
      {documented.map((param) => (
        <div key={param.id}>
          <dt className="mt-1.5 font-mono text-xs">{param.name}</dt>
          <dd className="m-0 ml-4 text-muted-foreground">
            <CommentBody hrefFor={hrefFor} parts={param.comment?.summary} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One property, method or accessor inside a class or interface. */
function MemberRow({ node, hrefFor }: { node: Reflection; hrefFor: HrefFor }) {
  const comment = commentOf(node);
  const signatures = signaturesOf(node);
  const isCallable =
    node.kind === Kind.Method || node.kind === Kind.Constructor;

  return (
    <div className="scroll-mt-4 py-2" id={`r${node.id}`}>
      <div className="overflow-x-auto font-mono text-[12.5px] whitespace-pre-wrap">
        <span className="font-semibold text-foreground">{node.name}</span>
        {node.flags?.isOptional && (
          <span className="text-muted-foreground">?</span>
        )}
        {isCallable ? (
          signatures.map((sig) => (
            <span key={sig.id}>
              <Params hrefFor={hrefFor} params={sig.parameters} />
              <span className="text-muted-foreground">: </span>
              <TypeSignature hrefFor={hrefFor} type={sig.type} />
            </span>
          ))
        ) : (
          <>
            <span className="text-muted-foreground">: </span>
            <TypeSignature
              hrefFor={hrefFor}
              type={node.type ?? signatures[0]?.type}
            />
          </>
        )}
        {node.flags?.isReadonly && (
          <Badge variant="secondary" className="ml-2">
            readonly
          </Badge>
        )}
      </div>
      <CommentBody hrefFor={hrefFor} parts={comment?.summary} />
      {isCallable &&
        signatures.map((sig) => (
          <ParamDocs hrefFor={hrefFor} key={sig.id} params={sig.parameters} />
        ))}
      <BlockTags hrefFor={hrefFor} tags={comment?.blockTags} />
    </div>
  );
}

/** A top-level export: its prose, its signature, and everything nested inside it. */
export function ApiMember({
  node,
  hrefFor,
}: {
  node: Reflection;
  hrefFor: HrefFor;
}) {
  const comment = commentOf(node);
  const source = node.sources?.[0];
  const label = KIND_LABEL[node.kind] ?? '';

  // Constructors come first, then whatever order TypeDoc found them in — which is
  // declaration order, and therefore the order the author meant them to be read.
  const children = (node.children ?? []).filter(
    (child) => child.kind !== Kind.Constructor || child.name !== 'constructor',
  );

  return (
    <section className="scroll-mt-4 border-b py-5" id={node.name}>
      <header className="flex flex-wrap items-baseline gap-2.5">
        <h2 className="font-mono text-base">
          <a className="hover:text-primary" href={`#${node.name}`}>
            {node.name}
          </a>
        </h2>
        {label && <Badge variant="outline">{label}</Badge>}
        {source && (
          <a
            className="ml-auto font-mono text-xs text-muted-foreground hover:text-primary"
            href={sourceUrl(source)}
            rel="noreferrer"
            target="_blank"
          >
            {source.fileName.replace('packages/papyra/src/', '')}:{source.line}
          </a>
        )}
      </header>

      {node.kind === Kind.Function &&
        node.signatures?.map((sig) => (
          <div
            className="mt-2 overflow-x-auto rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-[13px] whitespace-pre-wrap"
            key={sig.id}
          >
            <span className="font-semibold text-foreground">{node.name}</span>
            <Params hrefFor={hrefFor} params={sig.parameters} />
            <span className="text-muted-foreground">: </span>
            <TypeSignature hrefFor={hrefFor} type={sig.type} />
          </div>
        ))}

      {(node.kind === Kind.TypeAlias || node.kind === Kind.Variable) && (
        <div className="mt-2 overflow-x-auto rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-[13px] whitespace-pre-wrap">
          <span className="text-syntax-keyword">{label} </span>
          <span className="font-semibold text-foreground">{node.name}</span>
          <span className="text-muted-foreground">
            {node.kind === Kind.Variable ? ': ' : ' = '}
          </span>
          <TypeSignature hrefFor={hrefFor} type={node.type} />
        </div>
      )}

      {node.extendedTypes?.length ? (
        <div className="mt-2 pl-px font-mono text-xs whitespace-pre-wrap">
          <span className="text-syntax-keyword">extends </span>
          {node.extendedTypes.map((type, i) => (
            <span key={typeKey(type)}>
              {i > 0 && <span className="text-muted-foreground">, </span>}
              <TypeSignature hrefFor={hrefFor} type={type} />
            </span>
          ))}
        </div>
      ) : null}

      <CommentBody hrefFor={hrefFor} parts={comment?.summary} />
      {node.kind === Kind.Function &&
        node.signatures?.map((sig) => (
          <ParamDocs hrefFor={hrefFor} key={sig.id} params={sig.parameters} />
        ))}
      <BlockTags hrefFor={hrefFor} tags={comment?.blockTags} />

      {/*
       * Members hang off a rule rather than sitting in a box: at 20+ members a
       * bordered card each turns the page into a stack of frames and the prose stops
       * reading.
       */}
      {children.length > 0 && (
        <div className="mt-3 border-l pl-3.5">
          {children.map((child) => (
            <MemberRow hrefFor={hrefFor} key={child.id} node={child} />
          ))}
        </div>
      )}
    </section>
  );
}
