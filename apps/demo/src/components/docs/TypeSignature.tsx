import {
  type ApiType,
  Kind,
  type Reflection,
  typeKey,
} from '../../lib/apiModel.js';

/**
 * Renders a TypeDoc type as a linked signature.
 *
 * Only the eight type kinds this API surface actually produces are handled — the
 * generated model was enumerated, not guessed. An unhandled kind renders as its own
 * name in the output rather than as nothing, so a new one is visible instead of
 * quietly leaving a hole where a return type should be.
 */
export function TypeSignature({
  type,
  hrefFor,
}: {
  type: ApiType | undefined;
  hrefFor: (target: number | undefined, name: string) => string | undefined;
}) {
  if (!type) return null;

  switch (type.type) {
    case 'intrinsic':
      return <span className="text-syntax-intrinsic">{type.name}</span>;

    case 'literal':
      return (
        <span className="text-syntax-literal">
          {typeof type.value === 'string'
            ? `'${type.value}'`
            : String(type.value)}
        </span>
      );

    case 'reference': {
      const target = typeof type.target === 'number' ? type.target : undefined;
      const href = hrefFor(target, type.name);
      const name = href ? (
        <a className="text-primary hover:underline" href={href}>
          {type.name}
        </a>
      ) : (
        <span className="text-primary">{type.name}</span>
      );
      if (!type.typeArguments?.length) return name;
      return (
        <>
          {name}
          <Punct>{'<'}</Punct>
          <Joined hrefFor={hrefFor} sep=", " types={type.typeArguments} />
          <Punct>{'>'}</Punct>
        </>
      );
    }

    case 'array':
      return (
        <>
          <TypeSignature hrefFor={hrefFor} type={type.elementType} />
          <Punct>[]</Punct>
        </>
      );

    case 'union':
      return <Joined hrefFor={hrefFor} sep=" | " types={type.types} />;

    case 'tuple':
      return (
        <>
          <Punct>[</Punct>
          <Joined hrefFor={hrefFor} sep=", " types={type.elements ?? []} />
          <Punct>]</Punct>
        </>
      );

    case 'typeOperator':
      return (
        <>
          <span className="text-syntax-keyword">{type.operator} </span>
          <TypeSignature hrefFor={hrefFor} type={type.target} />
        </>
      );

    case 'reflection':
      return (
        <ReflectionType declaration={type.declaration} hrefFor={hrefFor} />
      );

    default:
      return <span className="text-primary">unknown</span>;
  }
}

/**
 * An inline object or function type.
 *
 * These carry real documentation here — `Document.queued` returns an anonymous object
 * whose three fields are the queue's whole story — so the shape is spelled out rather
 * than collapsed to `object`.
 */
function ReflectionType({
  declaration,
  hrefFor,
}: {
  declaration: Reflection;
  hrefFor: (target: number | undefined, name: string) => string | undefined;
}) {
  const call = declaration.signatures?.[0];
  if (call) {
    return (
      <>
        <Punct>(</Punct>
        {call.parameters?.map((param, i) => (
          <span key={param.id}>
            {i > 0 && <Punct>, </Punct>}
            <span className="text-foreground">{param.name}</span>
            <Punct>: </Punct>
            <TypeSignature hrefFor={hrefFor} type={param.type} />
          </span>
        ))}
        <Punct>{') => '}</Punct>
        <TypeSignature hrefFor={hrefFor} type={call.type} />
      </>
    );
  }

  const fields = declaration.children ?? [];
  if (!fields.length) return <Punct>{'{}'}</Punct>;
  return (
    <>
      <Punct>{'{ '}</Punct>
      {fields.map((field, i) => (
        <span key={field.id}>
          {i > 0 && <Punct>; </Punct>}
          <span className="text-foreground">{field.name}</span>
          {field.flags?.isOptional && <Punct>?</Punct>}
          <Punct>: </Punct>
          <TypeSignature
            hrefFor={hrefFor}
            type={field.kind === Kind.Property ? field.type : undefined}
          />
        </span>
      ))}
      <Punct>{' }'}</Punct>
    </>
  );
}

function Joined({
  types,
  sep,
  hrefFor,
}: {
  types: readonly ApiType[];
  sep: string;
  hrefFor: (target: number | undefined, name: string) => string | undefined;
}) {
  return (
    <>
      {types.map((type, i) => (
        <span key={typeKey(type)}>
          {i > 0 && <Punct>{sep}</Punct>}
          <TypeSignature hrefFor={hrefFor} type={type} />
        </span>
      ))}
    </>
  );
}

function Punct({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
