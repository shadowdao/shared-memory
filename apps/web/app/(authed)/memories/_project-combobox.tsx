"use client";

import { useEffect, useId, useRef, useState } from "react";

const field =
  "block w-full rounded-md bg-surface-1 border border-border " +
  "text-fg placeholder:text-fg-subtle " +
  "focus:border-accent-400 focus:outline-none " +
  "disabled:opacity-50 transition-colors h-9 px-3 text-sm";

/**
 * Type-ahead project filter. A text input whose value submits as `name`
 * (default "project") via the enclosing GET form, plus a dropdown of the
 * projects the user can read that narrows as they type. Selecting a
 * suggestion fills the box and submits the form so the filter applies
 * immediately; free text is still allowed (the input value is what
 * submits), so an arbitrary key keeps working even if it isn't listed.
 */
export function ProjectCombobox({
  name = "project",
  defaultValue = "",
  options,
  className = "",
}: {
  name?: string;
  defaultValue?: string;
  options: string[];
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Case-insensitive substring match. An empty box shows the full list so
  // the control doubles as a "browse my projects" dropdown.
  const q = value.trim().toLowerCase();
  const matches = q
    ? options.filter((o) => o.toLowerCase().includes(q))
    : options;

  // Close when focus/click leaves the widget.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function commit(next: string) {
    setValue(next);
    setOpen(false);
    // Write the DOM value synchronously before submitting: setValue only
    // schedules a re-render (React batches it), so the input's serialized
    // value would still be the pre-selection text when requestSubmit reads
    // it. The upcoming render sets the same value, so there's no flicker.
    if (inputRef.current) inputRef.current.value = next;
    // requestSubmit fires a real submit (unlike form.submit()).
    inputRef.current?.form?.requestSubmit();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
      } else {
        setActive((i) => Math.min(i + 1, matches.length - 1));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Only intercept Enter to pick a highlighted suggestion; otherwise
      // let it fall through and submit the form with the typed value.
      if (open && matches[active]) {
        e.preventDefault();
        commit(matches[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  const showList = open && matches.length > 0;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <input
        ref={inputRef}
        type="text"
        name={name}
        value={value}
        placeholder="Project key…"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          showList ? `${listId}-opt-${active}` : undefined
        }
        className={field}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-surface-1 py-1 shadow-lg"
        >
          {matches.map((opt, i) => (
            <li
              key={opt}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-3 py-1.5 font-mono text-sm text-fg ${
                i === active ? "bg-surface-2" : ""
              }`}
              // pointerdown (not click) so the choice registers before the
              // input's blur/outside-pointerdown handler closes the list.
              onPointerDown={(e) => {
                e.preventDefault();
                commit(opt);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {opt}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
