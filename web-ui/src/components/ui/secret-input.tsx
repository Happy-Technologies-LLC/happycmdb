// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1213: secret fields that keep their value out of the DOM.
 *
 * React syncs a controlled field's value into the DOM tree on every commit:
 * `<input value>` becomes the `value` attribute and `<textarea value>` becomes
 * its text content. Extensions, DOM snapshots, session-replay tools and error
 * reporters read the tree, not the `.value` property. These components pass no
 * `value`/`defaultValue` prop to the element and write the `.value` property
 * only, so the secret never reaches an attribute or a text node.
 *
 * Controlled semantics are kept: the layout effect runs after every render
 * and restores the `.value` property to the prop when they differ, and the
 * change handler forces a render so a parent that rejects an edit still
 * restores the field.
 */

import * as React from 'react';
import { Input, type InputProps } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type FieldElement = HTMLInputElement | HTMLTextAreaElement;

export function useUnmirroredValue<T extends FieldElement>(
  value: string,
  forwardedRef: React.ForwardedRef<T>,
  onChange: React.ChangeEventHandler<T> | undefined
) {
  const element = React.useRef<T | null>(null);
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);

  React.useLayoutEffect(() => {
    if (element.current && element.current.value !== value) {
      element.current.value = value;
    }
  });

  const ref = React.useCallback(
    (node: T | null) => {
      element.current = node;
      if (typeof forwardedRef === 'function') {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef]
  );

  const handleChange = React.useCallback(
    (event: React.ChangeEvent<T>) => {
      onChange?.(event);
      rerender();
    },
    [onChange]
  );

  return { ref, handleChange };
}

export interface SecretInputProps extends Omit<InputProps, 'value' | 'defaultValue' | 'type'> {
  value: string;
  /** `text` only while the user has chosen to reveal the secret. */
  type?: 'password' | 'text';
}

const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ value, onChange, type = 'password', autoComplete = 'new-password', ...props }, forwardedRef) => {
    const { ref, handleChange } = useUnmirroredValue(value, forwardedRef, onChange);
    return (
      <Input
        {...props}
        ref={ref}
        type={type}
        autoComplete={autoComplete}
        onChange={handleChange}
      />
    );
  }
);
SecretInput.displayName = 'SecretInput';

export interface SecretTextareaProps
  extends Omit<React.ComponentProps<'textarea'>, 'value' | 'defaultValue'> {
  value: string;
}

// A textarea cannot be type="password" (it would lose multi-line PEM input), so
// it gets no autofill and no spellcheck instead.
const SecretTextarea = React.forwardRef<HTMLTextAreaElement, SecretTextareaProps>(
  ({ value, onChange, autoComplete = 'off', spellCheck = false, ...props }, forwardedRef) => {
    const { ref, handleChange } = useUnmirroredValue(value, forwardedRef, onChange);
    return (
      <Textarea
        {...props}
        ref={ref}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        onChange={handleChange}
      />
    );
  }
);
SecretTextarea.displayName = 'SecretTextarea';

export { SecretInput, SecretTextarea };
