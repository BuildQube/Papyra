import { useEffect, useId, useRef, useState } from 'react';

interface Props {
  name: string;
  /** A password was already tried and rejected — `PasswordError.retry`. */
  retry: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/**
 * The dialog papyra's two password errors exist for.
 *
 * `PasswordRequiredError` and `IncorrectPasswordError` are separate types precisely so
 * this can be one component: the same form either asks cold or says the last answer
 * was wrong. The engine underneath cannot tell those apart — both are one
 * "password-protected" — so without the distinction this would either always accuse
 * the reader of getting it wrong or never tell them they had.
 */
export function PasswordPrompt({ name, retry, onSubmit, onCancel }: Props) {
  const [password, setPassword] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();

  // Clear the box on a rejection, so the next attempt starts from empty rather than
  // from the password that just failed.
  useEffect(() => {
    setPassword('');
    input.current?.focus();
  }, [retry]);

  return (
    <section className="password" aria-labelledby={titleId}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password) onSubmit(password);
        }}
      >
        <h2 id={titleId}>
          {retry ? 'That password did not work' : 'This PDF needs a password'}
        </h2>
        <p className="muted">{name}</p>

        <input
          ref={input}
          type="password"
          aria-label="Password"
          aria-invalid={retry}
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <div className="password-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!password}>
            Open
          </button>
        </div>
      </form>
    </section>
  );
}
