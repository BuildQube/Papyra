import { describe, expect, test } from 'bun:test';
import type { Attachment as NativeAttachment } from '@build-qube/papyra-native';
import {
  type Attachment,
  attachmentMediaType,
  isInvoiceAttachment,
  toAttachment,
} from '../../src/attachments.js';

function native(
  name: string,
  overrides: Partial<NativeAttachment> = {},
): NativeAttachment {
  return {
    name,
    description: undefined,
    mediaType: undefined,
    size: undefined,
    created: undefined,
    modified: undefined,
    relationship: undefined,
    ...overrides,
  };
}

/** A wrapper-side attachment with everything but `name` defaulted. */
function file(name: string, overrides: Partial<Attachment> = {}): Attachment {
  return { ...toAttachment(native(name), 0), ...overrides };
}

describe('toAttachment', () => {
  test('normalises absent fields to null and carries the index', () => {
    const a = toAttachment(native('notes.txt'), 3);
    expect(a.index).toBe(3);
    expect(a.description).toBeNull();
    expect(a.mediaType).toBeNull();
    expect(a.size).toBeNull();
    expect(a.created).toBeNull();
    expect(a.modified).toBeNull();
    expect(a.relationship).toBeNull();
  });

  test('keeps what the document did provide', () => {
    const a = toAttachment(
      native('invoice.xml', {
        description: 'The invoice',
        mediaType: 'application/xml',
        size: 2048,
        relationship: 'Alternative',
      }),
      0,
    );
    expect(a.description).toBe('The invoice');
    expect(a.mediaType).toBe('application/xml');
    expect(a.size).toBe(2048);
    expect(a.relationship).toBe('Alternative');
  });
});

describe('attachmentMediaType', () => {
  test('prefers what the document declared', () => {
    expect(
      attachmentMediaType(file('data.bin', { mediaType: 'application/xml' })),
    ).toBe('application/xml');
  });

  test('falls back to the extension, case-insensitively', () => {
    expect(attachmentMediaType(file('Invoice.XML'))).toBe('application/xml');
    expect(attachmentMediaType(file('sheet.csv'))).toBe('text/csv');
  });

  test('an unknown or absent extension is octet-stream', () => {
    expect(attachmentMediaType(file('mystery.qqq'))).toBe(
      'application/octet-stream',
    );
    expect(attachmentMediaType(file('README'))).toBe(
      'application/octet-stream',
    );
  });

  test('a dotfile has no extension, and is not treated as one', () => {
    expect(attachmentMediaType(file('.gitignore'))).toBe(
      'application/octet-stream',
    );
  });
});

describe('isInvoiceAttachment', () => {
  test('recognises the standardised filenames whatever their case', () => {
    expect(isInvoiceAttachment(file('factur-x.xml'))).toBe(true);
    expect(isInvoiceAttachment(file('ZUGFeRD-invoice.xml'))).toBe(true);
    expect(isInvoiceAttachment(file('xrechnung.xml'))).toBe(true);
    expect(isInvoiceAttachment(file('order-x.xml'))).toBe(true);
  });

  test('an ordinary XML attachment is not an invoice', () => {
    expect(isInvoiceAttachment(file('data.xml'))).toBe(false);
  });

  test('does not require the relationship to be set', () => {
    // Producers get `/AFRelationship` wrong often enough that requiring it would miss
    // real invoices; the filename is fixed by the specifications.
    expect(
      isInvoiceAttachment(file('factur-x.xml', { relationship: null })),
    ).toBe(true);
  });
});
