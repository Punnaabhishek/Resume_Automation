'use client';

import { useId, useMemo, useRef, useState } from 'react';

/**
 * A pick-from-a-list-or-type-your-own field, for roles, skills and excluded companies.
 *
 * A plain `<select>` is wrong for all three: none of them is a closed set. A job seeker's
 * target role may not be in any list we ship, skills appear faster than we can maintain a
 * taxonomy, and the companies someone refuses to apply to are by definition specific to them.
 * A dropdown that cannot express the real answer produces a wrong record, not a tidy one.
 *
 * So this is a combobox: suggestions to click, free text to type, and chosen values shown as
 * removable chips. What goes to the API is the same comma-free array either way.
 */
export function TagSelect({
  label,
  hint,
  values,
  onChange,
  suggestions,
  placeholder,
  required,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder?: string;
  required?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const lowerValues = useMemo(() => new Set(values.map((v) => v.toLowerCase())), [values]);

  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return suggestions
      .filter((s) => !lowerValues.has(s.toLowerCase()))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, 8);
  }, [draft, suggestions, lowerValues]);

  function add(value: string) {
    const clean = value.trim();
    if (!clean) return;
    // Case-insensitive dedupe: "node.js" and "Node.js" are the same skill to a reader, and
    // storing both makes the chip list look broken.
    if (lowerValues.has(clean.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...values, clean]);
    setDraft('');
    inputRef.current?.focus();
  }

  function remove(value: string) {
    onChange(values.filter((v) => v !== value));
  }

  return (
    <div className="tagselect">
      <span className="tagselect-label">
        {label}
        {hint && <span className="tagselect-hint">{hint}</span>}
      </span>

      {values.length > 0 && (
        <div className="chips">
          {values.map((value) => (
            <span className="chip chip-removable" key={value}>
              {value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => remove(value)}
                className="chip-x"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="tagselect-input">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          list={listId}
          placeholder={placeholder}
          // `required` is satisfied by having at least one chip, not by the draft box, so the
          // attribute goes on a hidden mirror below rather than here.
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && values.length) {
              remove(values[values.length - 1]!);
            }
          }}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button type="button" className="small" disabled={!draft.trim()} onClick={() => add(draft)}>
          Add
        </button>
      </div>

      {open && matches.length > 0 && (
        <div className="chips tagselect-suggestions">
          {matches.map((s) => (
            <button type="button" key={s} className="chip-btn" onClick={() => add(s)}>
              + {s}
            </button>
          ))}
        </div>
      )}

      {/*
        Keeps native form validation honest: the visible box is a draft field that is empty
        once a value is committed, so requiring it directly would block a fully-filled form.
      */}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden="true"
          required
          value={values.join(',')}
          onChange={() => {}}
          style={{ position: 'absolute', opacity: 0, height: 0, width: 0, padding: 0, border: 0 }}
        />
      )}
    </div>
  );
}
