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
      <span className="ty-punct">(</span>
      {params?.map((param, i) => (
        <span key={param.id}>
          {i > 0 && <span className="ty-punct">, </span>}
          <span className="ty-param">{param.name}</span>
          {param.flags?.isOptional && <span className="ty-punct">?</span>}
          <span className="ty-punct">: </span>
          <TypeSignature hrefFor={hrefFor} type={param.type} />
        </span>
      ))}
      <span className="ty-punct">)</span>
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
        <div className="api-tag" key={tag.tag}>
          <span className="api-tag-label">{tag.tag.replace('@', '')}</span>
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
    <dl className="api-params">
      {documented.map((param) => (
        <div key={param.id}>
          <dt>{param.name}</dt>
          <dd>
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
    <div className="api-member" id={`r${node.id}`}>
      <div className="api-member-sig">
        <span className="api-member-name">{node.name}</span>
        {node.flags?.isOptional && <span className="ty-punct">?</span>}
        {isCallable ? (
          signatures.map((sig) => (
            <span key={sig.id}>
              <Params hrefFor={hrefFor} params={sig.parameters} />
              <span className="ty-punct">: </span>
              <TypeSignature hrefFor={hrefFor} type={sig.type} />
            </span>
          ))
        ) : (
          <>
            <span className="ty-punct">: </span>
            <TypeSignature
              hrefFor={hrefFor}
              type={node.type ?? signatures[0]?.type}
            />
          </>
        )}
        {node.flags?.isReadonly && <span className="api-flag">readonly</span>}
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
    <section className="api-section" id={node.name}>
      <header className="api-head">
        <h2>
          <a className="api-anchor" href={`#${node.name}`}>
            {node.name}
          </a>
        </h2>
        {label && <span className="badge">{label}</span>}
        {source && (
          <a
            className="api-source"
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
          <div className="api-signature" key={sig.id}>
            <span className="api-member-name">{node.name}</span>
            <Params hrefFor={hrefFor} params={sig.parameters} />
            <span className="ty-punct">: </span>
            <TypeSignature hrefFor={hrefFor} type={sig.type} />
          </div>
        ))}

      {(node.kind === Kind.TypeAlias || node.kind === Kind.Variable) && (
        <div className="api-signature">
          <span className="ty-keyword">{label} </span>
          <span className="api-member-name">{node.name}</span>
          <span className="ty-punct">
            {node.kind === Kind.Variable ? ': ' : ' = '}
          </span>
          <TypeSignature hrefFor={hrefFor} type={node.type} />
        </div>
      )}

      {node.extendedTypes?.length ? (
        <div className="api-extends">
          <span className="ty-keyword">extends </span>
          {node.extendedTypes.map((type, i) => (
            <span key={typeKey(type)}>
              {i > 0 && <span className="ty-punct">, </span>}
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

      {children.length > 0 && (
        <div className="api-members">
          {children.map((child) => (
            <MemberRow hrefFor={hrefFor} key={child.id} node={child} />
          ))}
        </div>
      )}
    </section>
  );
}
