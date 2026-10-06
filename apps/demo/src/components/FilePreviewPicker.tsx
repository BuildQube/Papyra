import { Badge } from '@workspace/ui/components/badge';
import { CopyButton } from '@workspace/ui/components/copy-button';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@workspace/ui/components/toggle-group';
import { useMemo, useState } from 'react';
import {
  footprint,
  installCommand,
  type RegistryEntry,
  type RegistryIndex,
  SETUP_ANCHOR,
} from '../lib/registryModel.js';

const BLOCK = 'file-preview';

/** Where the generated file goes, and what it is called in a consumer. */
const SETUP_FILE = 'components/file-previewer.tsx';

/**
 * The setup file for a set of renderers. Byte-recognised formats first and name-
 * matched ones last: detection sniffs every renderer before it looks at names, so
 * the order only matters among the latter, but writing it in the safe order means
 * nobody has to know that.
 */
function setupFile(renderers: readonly RegistryEntry[]): string {
  const meta = renderers.map((e) => ({
    name: e.item.name,
    ...(e.item.meta?.fileRenderer ?? {
      id: e.item.name,
      export: e.item.name,
      label: '',
    }),
  }));
  const ordered = [
    ...meta.filter((m) => !m.byName),
    ...meta.filter((m) => m.byName),
  ];
  const imports = ordered
    .map((m) => `import { ${m.export} } from '@/components/${m.name}';`)
    .join('\n');
  const list = ordered.map((m) => `  ${m.export},`).join('\n');
  return `import { createFilePreview } from '@/components/file-preview-create';
${imports}

/**
 * Every format this app can preview. \`allow\` on each use narrows it further, and
 * is typed from this list: an id that is not here does not compile.
 */
export const FilePreviewer = createFilePreview([
${list}
]);

// <FilePreviewer files={files} allow={[${ordered
    .slice(0, 2)
    .map((m) => `'${m.id}'`)
    .join(', ')}]} />
`;
}

/**
 * Choose formats; get the install command, the packages they cost, and the file
 * that wires them up.
 *
 * Generated from the registry index rather than written here: a renderer is any item
 * whose `meta` carries `fileRenderer`, so a new format appears in the picker the day
 * its item is published.
 */
export function FilePreviewPicker({ registry }: { registry: RegistryIndex }) {
  const renderers = useMemo(
    () =>
      registry.entries
        .filter((e) => e.item.meta?.fileRenderer)
        // By name, with name-matched formats last — the order the setup file
        // needs, so the toggles read in the same order as the code below them.
        .sort((a, b) => {
          const x = a.item.meta?.fileRenderer;
          const y = b.item.meta?.fileRenderer;
          return (
            Number(!!x?.byName) - Number(!!y?.byName) ||
            (x?.label ?? '').localeCompare(y?.label ?? '')
          );
        }),
    [registry],
  );
  const [chosen, setChosen] = useState<string[]>([
    'file-preview-pdf',
    'file-preview-image',
  ]);

  const selected = renderers.filter((e) => chosen.includes(e.item.name));
  const names = [BLOCK, ...selected.map((e) => e.item.name)];
  const base = footprint([BLOCK], registry.byName);
  const total = footprint(names, registry.byName);
  const command = installCommand(...names);
  const code = setupFile(selected);

  /** npm packages this renderer adds over the bare block. */
  const adds = (name: string) =>
    footprint([BLOCK, name], registry.byName).npm.filter(
      (dep) => !base.npm.includes(dep),
    );

  return (
    <div className="mt-4 max-w-[74ch] rounded-md border p-4">
      <h4 className="text-sm font-medium">Choose your formats</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        Each format is its own item, so the ones you leave out cost nothing —
        not a dependency, not a byte. After the one-time{' '}
        <a className="underline underline-offset-2" href={`#${SETUP_ANCHOR}`}>
          registry setup
        </a>
        :
      </p>

      <ToggleGroup
        className="mt-3 flex-wrap"
        multiple
        onValueChange={(value) => setChosen(value as string[])}
        spacing={2}
        value={chosen}
        variant="outline"
      >
        {renderers.map((e) => {
          const extra = adds(e.item.name);
          return (
            <ToggleGroupItem
              className="h-auto flex-col items-start gap-0.5 px-3 py-2 text-left"
              key={e.item.name}
              value={e.item.name}
            >
              <span className="text-sm">
                {e.item.meta?.fileRenderer?.label}
              </span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {extra.length ? `+ ${extra.join(', ')}` : 'no new packages'}
              </span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>

      {selected.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Pick at least one format.
        </p>
      ) : (
        <>
          <p className="mt-4 text-xs font-medium">Install</p>
          <div className="mt-1 flex items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
              {command}
            </code>
            <CopyButton label="Copy the install command" value={command} />
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Adds to package.json
            {total.npm.map((dep) => (
              <Badge key={dep} variant="secondary">
                {dep}
              </Badge>
            ))}
            <span className="ml-1">
              · {total.items.length} papyra items, {total.shadcn.length} shadcn
              components
            </span>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <p className="font-mono text-xs">{SETUP_FILE}</p>
            <CopyButton label={`Copy ${SETUP_FILE}`} value={code} />
          </div>
          <pre className="mt-1 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {code}
          </pre>
        </>
      )}
    </div>
  );
}
