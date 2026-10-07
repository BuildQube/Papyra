import { describe, expect, test } from 'bun:test';
import { toRadix } from '../../scripts/radix.js';

const IMPORTS = [
  "import { Button } from '@/components/ui/button';",
  "import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';",
  "import { DialogTrigger } from '@/components/ui/dialog';",
  "import { Drawer } from '@/components/ui/drawer';",
  "import { TabsContent } from '@/components/ui/tabs';",
  "import { ToggleGroup } from '@/components/ui/toggle-group';",
  "import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';",
].join('\n');

/** Rewrite one JSX expression and return it with whitespace collapsed. */
function rewrite(jsx: string): string {
  const out = toRadix(`${IMPORTS}\nconst x = (${jsx});\n`, 'x.tsx');
  const body = out.slice(out.indexOf('const x = (') + 'const x = ('.length);
  return body.slice(0, body.lastIndexOf(');')).replace(/\s+/g, ' ').trim();
}

describe('toRadix', () => {
  test('moves the children of a render element inside it, under asChild', () => {
    expect(
      rewrite(
        '<CollapsibleTrigger render={<Button variant="ghost" />}><Icon /></CollapsibleTrigger>',
      ),
    ).toBe(
      '<CollapsibleTrigger asChild><Button variant="ghost"><Icon /></Button></CollapsibleTrigger>',
    );
  });

  test('rewrites nested render elements from the outside in', () => {
    expect(
      rewrite(
        '<Collapsible open={o} render={<li />}>{row}<CollapsibleContent render={<ul />}>{kids}</CollapsibleContent></Collapsible>',
      ),
    ).toBe(
      '<Collapsible open={o} asChild><li>{row}<CollapsibleContent asChild><ul>{kids}</ul></CollapsibleContent></li></Collapsible>',
    );
  });

  test('a caller-supplied element becomes the child expression', () => {
    expect(rewrite('<DialogTrigger render={trigger} />')).toBe(
      '<DialogTrigger asChild>{trigger}</DialogTrigger>',
    );
  });

  test('refuses a render prop it cannot place children into', () => {
    expect(() =>
      rewrite('<DialogTrigger render={trigger}>open</DialogTrigger>'),
    ).toThrow(/non-element render with children/);
  });

  test('leaves render on elements that are not shadcn primitives alone', () => {
    expect(rewrite('<Mine render={<li />}>x</Mine>')).toBe(
      '<Mine render={<li />}>x</Mine>',
    );
  });

  test('keepMounted becomes forceMount, hidden while inactive', () => {
    expect(
      rewrite(
        '<TabsContent value="a" keepMounted className="p-2">x</TabsContent>',
      ),
    ).toBe(
      '<TabsContent value="a" forceMount className="p-2 data-[state=inactive]:hidden">x</TabsContent>',
    );
  });

  test('a single-select toggle group unwraps its value and handler', () => {
    expect(
      rewrite(
        '<ToggleGroup value={[mode]} onValueChange={([next]) => set(next)}>x</ToggleGroup>',
      ),
    ).toBe(
      '<ToggleGroup type="single" value={mode} onValueChange={(next) => set(next)}>x</ToggleGroup>',
    );
  });

  test('a toggle group handler it cannot unwrap is an error', () => {
    expect(() =>
      rewrite(
        '<ToggleGroup value={[mode]} onValueChange={(v) => set(v[0])}>x</ToggleGroup>',
      ),
    ).toThrow(/\(\[value\]\) =>/);
  });

  test('drops props Radix has no counterpart for', () => {
    expect(rewrite('<Drawer open={o} showSwipeHandle>x</Drawer>')).toBe(
      '<Drawer open={o} >x</Drawer>',
    );
  });

  test('a tooltip outside a provider is an error, since Radix throws', () => {
    expect(() => rewrite('<Tooltip>x</Tooltip>')).toThrow(/TooltipProvider/);
    expect(
      rewrite('<TooltipProvider><Tooltip>x</Tooltip></TooltipProvider>'),
    ).toBe('<TooltipProvider><Tooltip>x</Tooltip></TooltipProvider>');
  });

  test('returns a file with no primitives unchanged', () => {
    const source = 'export const a = <li render={<b />} />;\n';
    expect(toRadix(source, 'a.tsx')).toBe(source);
  });
});
