import { describe, expect, test } from 'bun:test';
import {
  IncorrectPasswordError,
  PasswordError,
  PasswordRequiredError,
  rethrowLoadError,
} from '../../src/errors.js';

/** What `rethrowLoadError` threw, or the sentinel if it somehow returned. */
function thrownBy(error: unknown): unknown {
  try {
    rethrowLoadError(error);
  } catch (e) {
    return e;
  }
}

describe('rethrowLoadError', () => {
  test('turns the password-required tag into a typed error', () => {
    const thrown = thrownBy(
      new Error('papyra/password-required this PDF is password-protected'),
    );
    expect(thrown).toBeInstanceOf(PasswordRequiredError);
    expect(thrown).toBeInstanceOf(PasswordError);
    expect((thrown as PasswordError).retry).toBe(false);
  });

  test('turns the incorrect-password tag into a typed error', () => {
    const thrown = thrownBy(
      new Error('papyra/incorrect-password the supplied password is incorrect'),
    );
    expect(thrown).toBeInstanceOf(IncorrectPasswordError);
    expect((thrown as PasswordError).retry).toBe(true);
  });

  test('strips the tag, so a caller never sees it', () => {
    // The tag is a transport detail between the bindings and this wrapper.
    const thrown = thrownBy(
      new Error('papyra/password-required this PDF is password-protected'),
    );
    expect((thrown as Error).message).toBe('this PDF is password-protected');
  });

  test('rethrows anything else untouched', () => {
    const original = new Error('failed to parse PDF: Invalid');
    expect(thrownBy(original)).toBe(original);
  });

  test('rethrows a non-Error untouched', () => {
    expect(thrownBy('nope')).toBe('nope');
  });
});
