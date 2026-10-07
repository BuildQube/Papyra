import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { codeRenderer } from '@/components/file-preview-code';
import { docxRenderer } from '@/components/file-preview-docx';
import {
  isWordPackage,
  linkPolicy,
  openWordDocument,
  withGenericFont,
} from '@/components/file-preview-docx-view';
import { imageRenderer } from '@/components/file-preview-image';
import { pdfRenderer } from '@/components/file-preview-pdf';
import { spreadsheetRenderer } from '@/components/file-preview-spreadsheet';
import { detectHead } from '@/lib/file-preview-core';

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
const ALL = [
  pdfRenderer,
  imageRenderer,
  spreadsheetRenderer,
  docxRenderer,
  codeRenderer,
] as const;
const idOf = (name: string, type = '', head = ZIP) => {
  const d = detectHead({ name, type }, head, ALL);
  return d.status === 'ok' ? d.renderer.id : d.status;
};

const contentTypes = (main: string) =>
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/main.xml" ContentType="${main}"/></Types>`;

async function zipFile(name: string, parts: Record<string, string>) {
  const zip = new JSZip();
  for (const [path, body] of Object.entries(parts)) zip.file(path, body);
  return new File([await zip.generateAsync({ type: 'arraybuffer' })], name);
}

describe('docx detection', () => {
  test('a zip named .docx is a Word document, beside a spreadsheet renderer', () => {
    expect(idOf('report.docx')).toBe('docx');
    expect(idOf('macros.docm')).toBe('docx');
    expect(idOf('letterhead.dotx')).toBe('docx');
    expect(idOf('book.xlsx')).toBe('spreadsheet');
  });

  test('the MIME type is enough when the name says nothing', () => {
    expect(
      idOf(
        'download',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('docx');
  });

  test('a zip signature alone claims nothing', () => {
    expect(idOf('archive.zip')).toBe('unsupported');
  });

  test('legacy .doc falls through to the download card', () => {
    const ole = new Uint8Array([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
    expect(idOf('memo.doc', 'application/msword', ole)).toBe('unsupported');
  });
});

describe('isWordPackage', () => {
  test.each([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
    'application/vnd.ms-word.document.macroEnabled.main+xml',
    'application/vnd.ms-word.template.macroEnabledTemplate.main+xml',
  ])('accepts %s', (type) => {
    expect(isWordPackage(contentTypes(type))).toBe(true);
  });

  test.each([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  ])('refuses %s', (type) => {
    expect(isWordPackage(contentTypes(type))).toBe(false);
  });
});

describe('openWordDocument refuses what is not a Word document', () => {
  test('text with a .docx name', async () => {
    const file = new File(['just some text'], 'not-really.docx');
    await expect(openWordDocument(file)).rejects.toThrow(
      'This file is not a Word document.',
    );
  });

  test('a workbook renamed to .docx', async () => {
    const file = await zipFile('book.docx', {
      '[Content_Types].xml': contentTypes(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
      ),
      'xl/workbook.xml': '<workbook/>',
    });
    await expect(openWordDocument(file)).rejects.toThrow(
      'This file is not a Word document.',
    );
  });

  test('a password-protected document says so', async () => {
    // Word encrypts a .docx into an OLE compound file, the container of a .doc.
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const file = new File([ole], 'locked.docx');
    await expect(openWordDocument(file)).rejects.toThrow('password-protected');
  });

  test('a plain zip with no content types', async () => {
    const file = await zipFile('files.docx', { 'readme.txt': 'hello' });
    await expect(openWordDocument(file)).rejects.toThrow(
      'This file is not a Word document.',
    );
  });
});

describe('withGenericFont', () => {
  test.each([
    ["'Calibri'", "'Calibri', sans-serif"],
    ['var(--docx-minorHAnsi-font)', 'var(--docx-minorHAnsi-font), sans-serif'],
    ["'Cambria'", "'Cambria', serif"],
    ['Times New Roman', 'Times New Roman, serif'],
    ["'Consolas'", "'Consolas', monospace"],
    ['Arial, sans-serif', 'Arial, sans-serif'],
    ['', ''],
  ])('%p becomes %p', (value, expected) => {
    expect(withGenericFont(value)).toBe(expected);
  });
});

describe('linkPolicy', () => {
  test.each([
    ['https://example.com/a?b=c', 'https://example.com/a?b=c'],
    ['http://example.com', 'http://example.com/'],
    ['mailto:someone@example.com', 'mailto:someone@example.com'],
    ['tel:+15555550100', 'tel:+15555550100'],
  ])('keeps %s, in a new tab', (href, expected) => {
    expect(linkPolicy(href)).toEqual({ href: expected, external: true });
  });

  test('keeps a bookmark in the same document, in place', () => {
    expect(linkPolicy('#_Toc123')).toEqual({
      href: '#_Toc123',
      external: false,
    });
  });

  test.each([
    ['javascript:alert(1)'],
    [' JavaScript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox'],
    ['file:///etc/passwd'],
    ['../relative/path.docx'],
    ['#'],
    [''],
    [null],
  ])('drops %p', (href) => {
    expect(linkPolicy(href)).toBeUndefined();
  });
});
