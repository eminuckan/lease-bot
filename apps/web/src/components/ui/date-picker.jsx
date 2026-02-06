import { format, isValid, parse } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { Calendar } from "./calendar";
import { Input } from "./input";

function parseDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }

  const parsed = parse(value, "yyyy-MM-dd", new Date());
  if (!isValid(parsed)) {
    return undefined;
  }

  return format(parsed, "yyyy-MM-dd") === value ? parsed : undefined;
}

export function DatePicker({ id, value, onChange, className, placeholder = "YYYY-MM-DD", disabled = false }) {
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(value || "");
  const [hasInvalidInput, setHasInvalidInput] = useState(false);
  const rootRef = useRef(null);
  const selectedDate = useMemo(() => parseDateString(value || ""), [value]);
  const dialogId = `${id}-calendar-dialog`;
  const headingId = `${id}-calendar-heading`;
  const formatHintId = `${id}-format-hint`;

  useEffect(() => {
    setDraftValue(value || "");
  }, [value]);

  function commitDraft(nextValue) {
    const trimmedValue = nextValue.trim();

    if (trimmedValue === "") {
      setDraftValue("");
      setHasInvalidInput(false);
      onChange("");
      return true;
    }

    const parsedDate = parseDateString(trimmedValue);
    if (!parsedDate) {
      setHasInvalidInput(true);
      return false;
    }

    const normalizedValue = format(parsedDate, "yyyy-MM-dd");
    setDraftValue(normalizedValue);
    setHasInvalidInput(false);
    onChange(normalizedValue);
    return true;
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleClick(event) {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <div className="flex gap-2">
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draftValue}
          disabled={disabled}
          placeholder={placeholder}
          aria-haspopup="dialog"
          aria-controls={dialogId}
          aria-describedby={formatHintId}
          aria-expanded={open}
          aria-invalid={hasInvalidInput}
          onChange={(event) => {
            setDraftValue(event.target.value);
            setHasInvalidInput(false);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            if (!open) {
              if (!commitDraft(draftValue)) {
                setDraftValue(value || "");
              }
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!commitDraft(draftValue)) {
                setDraftValue(value || "");
              }
            }

            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        />
        <button
          type="button"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          aria-label="Open calendar"
          aria-haspopup="dialog"
          aria-controls={dialogId}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          Cal
        </button>
      </div>
      <p id={formatHintId} className="sr-only">
        Date format must be year-month-day, for example 2026-03-05.
      </p>

      {open ? (
        <div
          id={dialogId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          className="absolute left-0 top-[calc(100%+0.5rem)] z-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <p id={headingId} className="sr-only">
            Choose date
          </p>
          <Calendar
            mode="single"
            autoFocus
            aria-labelledby={headingId}
            selected={selectedDate}
            defaultMonth={selectedDate}
            onSelect={(nextDate) => {
              if (!nextDate) {
                onChange("");
                setOpen(false);
                return;
              }

              onChange(format(nextDate, "yyyy-MM-dd"));
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
