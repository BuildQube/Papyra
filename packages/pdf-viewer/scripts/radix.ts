/**
 * Rewrite a registry file written against Base UI into its Radix equivalent.
 *
 * The items are authored once, against Base UI, and `build-registry.ts` runs every
 * file through this before building the `/r/radix` flavour. That works because the
 * two libraries differ in very few places the items touch — the shadcn wrappers in
 * `@/components/ui/*` absorb the rest — and every one of those places is a
 * mechanical rewrite:
 *
 * - `render={<X …/>}` composition is Radix's `asChild` with `X` as the child.
 * - `keepMounted` is `forceMount`, which Radix leaves *visible* when inactive, so
 *   the element also gets `data-[state=inactive]:hidden`.
 * - `ToggleGroup` is single-select by `type`, not by an array of one, so
 *   `value={[v]}` becomes `value={v}` and an `([next]) =>` handler becomes
 *   `(next) =>`. The source has to destructure for that, which is the one
 *   constraint this puts on how the Base UI file is written.
 * - The drawer's `showSwipeHandle` has no Radix counterpart and is dropped.
 *
 * One difference is not a rewrite but a rule on the source: Radix's `Tooltip`
 * throws unless a `TooltipProvider` is above it, where Base UI's needs none. An
 * item cannot assume the consumer's app set one up, so every `Tooltip` must sit
 * inside a provider in its own file, and this enforces it. Nothing else would:
 * the omission typechecks, and fails only once the tooltip renders.
 *
 * Anything else that looks Base UI-specific throws rather than passing through: a
 * file this cannot rewrite must fail the build, not ship and fail the consumer's
 * typecheck. `bun run check:registry` installs both flavours into fresh projects and
 * typechecks them, which is what catches an API difference this does not know of.
 */
import {
  type JsxAttribute,
  type JsxElement,
  type JsxSelfClosingElement,
  Node,
  Project,
  type SourceFile,
} from 'ts-morph';

/** Hides a forced-mounted panel whose Radix parent says it is not the open one. */
const INACTIVE_HIDDEN = 'data-[state=inactive]:hidden';

/** Props with no Radix counterpart, dropped by component. */
const DROPPED: Record<string, readonly string[]> = {
  Drawer: ['showSwipeHandle'],
};

/** Base UI props the rules below do not cover; finding one is a build error. */
const UNSUPPORTED = ['nativeButton'];

const project = new Project({ useInMemoryFileSystem: true });

/** One rewrite applied to the text, after which the file is re-parsed. */
type Edit = { start: number; end: number; text: string };

export function toRadix(source: string, fileName: string): string {
  let text = source;
  // One edit per pass: a `render` element nested inside another (a collapsible
  // `<li>` holding a collapsible `<ul>`) is rewritten from fresh positions each
  // time, rather than splicing overlapping ranges.
  for (let pass = 0; pass < 1000; pass++) {
    const file = project.createSourceFile(fileName, text, { overwrite: true });
    const edit = nextEdit(file, fileName);
    if (!edit) return text;
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  throw new Error(`${fileName}: rewrite did not converge`);
}

function nextEdit(file: SourceFile, fileName: string): Edit | undefined {
  const ui = uiComponents(file);
  if (ui.size === 0) return undefined;

  for (const node of file.getDescendants()) {
    if (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node)) {
      continue;
    }
    const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
    const tag = opening.getTagNameNode().getText();
    if (!ui.has(tag)) continue;

    const where = `${fileName}:${node.getStartLineNumber()} <${tag}>`;
    const attrs = opening.getAttributes();
    const named = (name: string) =>
      attrs.find(
        (a): a is JsxAttribute =>
          Node.isJsxAttribute(a) && a.getNameNode().getText() === name,
      );

    for (const prop of UNSUPPORTED) {
      if (named(prop)) throw new Error(`${where}: no Radix rule for ${prop}`);
    }

    if (tag === 'Tooltip' && !insideProvider(node)) {
      throw new Error(
        `${where}: wrap it in <TooltipProvider> — Radix throws without one`,
      );
    }

    const render = named('render');
    if (render) return asChild(node, tag, render, where);

    const keepMounted = named('keepMounted');
    if (keepMounted) return forceMount(node, keepMounted, named, where);

    for (const prop of DROPPED[tag] ?? []) {
      const attr = named(prop);
      if (attr) return remove(attr);
    }

    if (tag === 'ToggleGroup' && !named('type')) {
      return toggleGroup(node, tag, named, where);
    }
  }
  return undefined;
}

function insideProvider(node: Node): boolean {
  return node.getAncestors().some((a) => {
    const opening = Node.isJsxElement(a) ? a.getOpeningElement() : undefined;
    return opening?.getTagNameNode().getText() === 'TooltipProvider';
  });
}

/** Names imported from the shadcn primitives, the only elements rewritten. */
function uiComponents(file: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const decl of file.getImportDeclarations()) {
    if (!decl.getModuleSpecifierValue().startsWith('@/components/ui/'))
      continue;
    for (const named of decl.getNamedImports()) {
      names.add(named.getAliasNode()?.getText() ?? named.getName());
    }
  }
  return names;
}

/**
 * `<Outer a render={<Inner b />}>kids</Outer>` → `<Outer a asChild><Inner b>kids</Inner></Outer>`.
 * A non-element `render` (a prop holding a caller's element) becomes the child
 * as an expression, which is only sound when the outer element has no children.
 */
function asChild(
  node: JsxElement | JsxSelfClosingElement,
  tag: string,
  render: JsxAttribute,
  where: string,
): Edit {
  const init = render.getInitializer();
  if (!init || !Node.isJsxExpression(init) || !init.getExpression()) {
    throw new Error(`${where}: render must be an expression`);
  }
  let target = init.getExpressionOrThrow();
  while (Node.isParenthesizedExpression(target)) {
    target = target.getExpression();
  }

  const kids = Node.isJsxElement(node)
    ? node
        .getJsxChildren()
        .map((c) => c.getText())
        .join('')
    : '';
  const hasKids = kids.trim() !== '';

  let child: string;
  if (Node.isJsxSelfClosingElement(target)) {
    const inner = target.getTagNameNode().getText();
    const innerAttrs = target
      .getAttributes()
      .map((a) => a.getText())
      .join(' ');
    const open = innerAttrs ? `<${inner} ${innerAttrs}` : `<${inner}`;
    child = hasKids ? `${open}>${kids}</${inner}>` : target.getText();
  } else if (Node.isJsxElement(target)) {
    if (hasKids) throw new Error(`${where}: render element and children both`);
    child = target.getText();
  } else {
    if (hasKids) {
      throw new Error(`${where}: non-element render with children`);
    }
    child = `{${target.getText()}}`;
  }

  const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
  const rest = opening
    .getAttributes()
    .filter((a) => a !== render)
    .map((a) => a.getText());
  return {
    start: node.getStart(),
    end: node.getEnd(),
    text: `<${tag} ${[...rest, 'asChild'].join(' ')}>${child}</${tag}>`,
  };
}

function forceMount(
  node: JsxElement | JsxSelfClosingElement,
  keepMounted: JsxAttribute,
  named: (name: string) => JsxAttribute | undefined,
  where: string,
): Edit {
  if (keepMounted.getInitializer()) {
    throw new Error(`${where}: keepMounted must be a bare attribute`);
  }
  const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
  const className = named('className');
  const attrs = opening.getAttributes().map((a) => {
    if (a === keepMounted) return 'forceMount';
    if (a !== className) return a.getText();
    const value = className.getInitializer();
    if (!value || !Node.isStringLiteral(value)) {
      throw new Error(`${where}: className must be a string literal`);
    }
    return `className="${value.getLiteralText()} ${INACTIVE_HIDDEN}"`;
  });
  if (!className) attrs.push(`className="${INACTIVE_HIDDEN}"`);
  return replaceAttributes(opening, attrs);
}

function toggleGroup(
  node: JsxElement | JsxSelfClosingElement,
  tag: string,
  named: (name: string) => JsxAttribute | undefined,
  where: string,
): Edit {
  const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
  const multiple = named('multiple');
  if (multiple) {
    const attrs = opening
      .getAttributes()
      .map((a) => (a === multiple ? 'type="multiple"' : a.getText()));
    return replaceAttributes(opening, attrs);
  }

  const single = (attr: JsxAttribute) => {
    const init = attr.getInitializer();
    const array =
      init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
    if (!array || !Node.isArrayLiteralExpression(array)) {
      throw new Error(`${where}: ${tag} value must be an array literal`);
    }
    const elements = array.getElements();
    if (elements.length !== 1) {
      throw new Error(`${where}: single-select ${tag} needs one value`);
    }
    return `${attr.getNameNode().getText()}={${elements[0]?.getText()}}`;
  };

  const handler = (attr: JsxAttribute) => {
    const init = attr.getInitializer();
    const fn =
      init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
    const param =
      fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))
        ? fn.getParameters()[0]
        : undefined;
    const pattern = param?.getNameNode();
    if (
      !fn ||
      !pattern ||
      !Node.isArrayBindingPattern(pattern) ||
      pattern.getElements().length !== 1
    ) {
      throw new Error(
        `${where}: write onValueChange as ([value]) => … so it can be rewritten`,
      );
    }
    const element = pattern.getElements()[0];
    const text = fn.getText();
    const offset = fn.getStart();
    const replaced =
      text.slice(0, pattern.getStart() - offset) +
      (element?.getText() ?? '') +
      text.slice(pattern.getEnd() - offset);
    return `onValueChange={${replaced}}`;
  };

  const attrs = opening.getAttributes().map((a) => {
    if (!Node.isJsxAttribute(a)) return a.getText();
    const name = a.getNameNode().getText();
    if (name === 'value' || name === 'defaultValue') return single(a);
    if (name === 'onValueChange') return handler(a);
    return a.getText();
  });
  return replaceAttributes(opening, ['type="single"', ...attrs]);
}

function replaceAttributes(
  opening: JsxSelfClosingElement | ReturnType<JsxElement['getOpeningElement']>,
  attrs: string[],
): Edit {
  const tag = opening.getTagNameNode().getText();
  const close = Node.isJsxSelfClosingElement(opening) ? ' />' : '>';
  return {
    start: opening.getStart(),
    end: opening.getEnd(),
    text: `<${tag} ${attrs.join(' ')}${close}`,
  };
}

function remove(attr: JsxAttribute): Edit {
  return { start: attr.getStart(), end: attr.getEnd(), text: '' };
}
