/**
 * Tags the bindings put in front of a load failure's message.
 *
 * napi-rs gives every error it throws the same `code`, so the message is the only
 * channel a typed failure can travel through. These are stripped before the error
 * reaches a caller — keep them in step with `TAG_PASSWORD_REQUIRED` and
 * `TAG_INCORRECT_PASSWORD` in `packages/bindings/src/lib.rs`.
 */
const TAGS = {
  'papyra/password-required': (message: string) =>
    new PasswordRequiredError(message),
  'papyra/incorrect-password': (message: string) =>
    new IncorrectPasswordError(message),
} as const;

/**
 * A document that could not be opened because of its password.
 *
 * The base of both password failures, because a viewer handles them in one place: a
 * dialog that either asks for the first time or says the last answer was wrong.
 *
 * @example
 * ```ts
 * try {
 *   doc = await open(file, { password });
 * } catch (e) {
 *   if (e instanceof PasswordError) showPasswordDialog({ retry: e.retry });
 *   else throw e;
 * }
 * ```
 */
export class PasswordError extends Error {
  /**
   * A password was already tried and rejected.
   *
   * `false` the first time, so a dialog can open without an error on it.
   */
  readonly retry: boolean = false;
}

/** The document is encrypted and {@link OpenOptions.password} was not supplied. */
export class PasswordRequiredError extends PasswordError {
  /** Always `'PasswordRequiredError'`. */
  override readonly name = 'PasswordRequiredError';
  override readonly retry = false;
  constructor(message = 'this PDF is password-protected') {
    super(message);
  }
}

/** A password was supplied and it did not open the document. */
export class IncorrectPasswordError extends PasswordError {
  /** Always `'IncorrectPasswordError'`. */
  override readonly name = 'IncorrectPasswordError';
  override readonly retry = true;
  constructor(message = 'the supplied password is incorrect') {
    super(message);
  }
}

/**
 * Rethrow a load failure as itself, or as the typed error it was tagged as.
 *
 * @internal
 */
export function rethrowLoadError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  for (const [tag, build] of Object.entries(TAGS)) {
    if (message.startsWith(tag)) {
      throw build(message.slice(tag.length).trim());
    }
  }
  throw error;
}
