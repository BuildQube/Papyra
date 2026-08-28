import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/** Props for {@link PasswordPrompt}. */
export interface PasswordPromptProps {
  /** The file name, shown so the reader knows which document is asking. */
  name: string;
  /** A password was already tried and rejected — `PasswordError.retry`. */
  retry: boolean;
  /** Called with the typed password when the form is submitted. */
  onSubmit: (password: string) => void;
  /** Called when the reader gives up rather than answering. */
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
 *
 * A card in the page rather than a `Dialog`: there is no document behind it to be
 * modal over, and a modal with nothing underneath is a card with extra machinery.
 */
export function PasswordPrompt({
  name,
  retry,
  onSubmit,
  onCancel,
}: PasswordPromptProps) {
  const [password, setPassword] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();

  useEffect(() => {
    setPassword('');
    input.current?.focus();
  }, [retry]);

  return (
    <section
      aria-labelledby={titleId}
      className="grid flex-1 place-items-center p-12"
    >
      <Card className="w-90 max-w-full">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password) onSubmit(password);
          }}
        >
          <CardHeader>
            <CardTitle id={titleId}>
              {retry
                ? 'That password did not work'
                : 'This PDF needs a password'}
            </CardTitle>
            <CardDescription className="wrap-anywhere">{name}</CardDescription>
          </CardHeader>

          <CardContent>
            <FieldGroup>
              <Field data-invalid={retry || undefined}>
                <FieldLabel htmlFor={inputId}>Password</FieldLabel>
                <Input
                  id={inputId}
                  ref={input}
                  type="password"
                  aria-invalid={retry}
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </CardContent>

          <CardFooter className="justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password}>
              Open
            </Button>
          </CardFooter>
        </form>
      </Card>
    </section>
  );
}
