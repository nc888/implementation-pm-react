import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";

export function Badge({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  tone = "",
  type = "button",
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: string;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  return (
    <button type={type} className={`button ${tone}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function Metric({ title, value, delta, tone = "primary" }: { title: string; value: string | number; delta: string; tone?: string }) {
  return (
    <Card className="metric-card">
      <small>{title}</small>
      <div className="metric-value">
        <strong>{value}</strong>
        <Badge tone={tone}>{delta}</Badge>
      </div>
    </Card>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const weekDays = ["一", "二", "三", "四", "五", "六", "日"];
const datePopoverWidth = 292;
const datePopoverEstimatedHeight = 340;
const datePopoverViewportGap = 12;

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatIsoDate(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseIsoDate(value?: string) {
  if (!value || !isoDatePattern.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function addDateDays(value: string, days: number) {
  const date = parseIsoDate(value) || new Date();
  date.setDate(date.getDate() + days);
  return formatIsoDate(date);
}

function monthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function moveMonth(date: Date, delta: number) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function monthTitle(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function dateWithinBounds(value: string, min?: string, max?: string) {
  if (!value) return true;
  if (min && value < min) return false;
  if (max && value > max) return false;
  return true;
}

function calendarDaysForMonth(monthDate: Date) {
  const start = monthStart(monthDate);
  const leading = (start.getDay() + 6) % 7;
  const firstCell = new Date(start);
  firstCell.setDate(start.getDate() - leading);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(firstCell);
    date.setDate(firstCell.getDate() + index);
    return date;
  });
}

export function DateField({
  name,
  label,
  value,
  defaultValue = "",
  onChange,
  required = false,
  disabled = false,
  min,
  max,
  placeholder = "YYYY-MM-DD",
  ariaLabel,
  compact = false,
  hideLabel = false,
  showStepButtons = true,
  className = "",
}: {
  name?: string;
  label?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  placeholder?: string;
  ariaLabel?: string;
  compact?: boolean;
  hideLabel?: boolean;
  showStepButtons?: boolean;
  className?: string;
}) {
  const controlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const selectedValue = controlled ? value : internalValue;
  const [draft, setDraft] = useState(selectedValue || "");
  const [open, setOpen] = useState(false);
  const [monthDate, setMonthDate] = useState(() => monthStart(parseIsoDate(selectedValue) || new Date()));
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: datePopoverEstimatedHeight, placement: "bottom" as "top" | "bottom" });
  const fieldRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const todayValue = formatIsoDate(new Date());
  const calendarDays = useMemo(() => calendarDaysForMonth(monthDate), [monthDate]);

  useEffect(() => {
    setDraft(selectedValue || "");
    const parsed = parseIsoDate(selectedValue);
    if (parsed) setMonthDate(monthStart(parsed));
  }, [selectedValue]);

  const commitValue = (nextValue: string) => {
    if (nextValue && (!parseIsoDate(nextValue) || !dateWithinBounds(nextValue, min, max))) {
      setDraft(selectedValue || "");
      return;
    }
    if (!controlled) setInternalValue(nextValue);
    setDraft(nextValue);
    onChange?.(nextValue);
  };

  const updatePosition = () => {
    const rect = fieldRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 768;
    const left = Math.max(datePopoverViewportGap, Math.min(rect.left, viewportWidth - datePopoverWidth - datePopoverViewportGap));
    const spaceBelow = viewportHeight - rect.bottom - datePopoverViewportGap;
    const spaceAbove = rect.top - datePopoverViewportGap;
    const shouldOpenUp = spaceBelow < datePopoverEstimatedHeight && spaceAbove > spaceBelow;
    const availableHeight = Math.max(220, shouldOpenUp ? spaceAbove - 8 : spaceBelow - 8);
    const top = shouldOpenUp ? Math.max(datePopoverViewportGap, rect.top - Math.min(datePopoverEstimatedHeight, availableHeight) - 8) : rect.bottom + 8;
    setPosition({
      top,
      left,
      width: Math.max(rect.width, 220),
      maxHeight: Math.min(datePopoverEstimatedHeight, availableHeight),
      placement: shouldOpenUp ? "top" : "bottom",
    });
  };

  const openCalendar = () => {
    if (disabled) return;
    updatePosition();
    setOpen(true);
  };

  const closeCalendar = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (fieldRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, selectedValue]);

  const chooseDate = (nextValue: string) => {
    commitValue(nextValue);
    closeCalendar();
    inputRef.current?.focus();
  };

  const commitDraft = () => {
    const nextValue = draft.trim();
    if (!nextValue) {
      if (!required) commitValue("");
      else setDraft(selectedValue || "");
      return;
    }
    commitValue(nextValue);
  };

  const stepDate = (days: number) => {
    const nextValue = addDateDays(selectedValue || todayValue, days);
    commitValue(nextValue);
    setMonthDate(monthStart(parseIsoDate(nextValue) || new Date()));
  };

  const setToday = () => {
    commitValue(todayValue);
    setMonthDate(monthStart(new Date()));
  };

  const popover = open
    ? createPortal(
        <div
          ref={popoverRef}
          className={`date-popover ${position.placement === "top" ? "open-up" : "open-down"}`}
          style={{ top: position.top, left: position.left, minWidth: position.width, maxHeight: position.maxHeight }}
          role="dialog"
          aria-label={`${label || ariaLabel || "日期"}日历`}
        >
          <div className="date-popover-head">
            <button type="button" onClick={() => setMonthDate((current) => moveMonth(current, -1))} aria-label="上个月">
              <ChevronLeft aria-hidden="true" />
            </button>
            <strong>{monthTitle(monthDate)}</strong>
            <button type="button" onClick={() => setMonthDate((current) => moveMonth(current, 1))} aria-label="下个月">
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <div className="date-weekdays" aria-hidden="true">
            {weekDays.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="date-grid">
            {calendarDays.map((date) => {
              const iso = formatIsoDate(date);
              const outside = date.getMonth() !== monthDate.getMonth();
              const selected = iso === selectedValue;
              const isToday = iso === todayValue;
              const blocked = !dateWithinBounds(iso, min, max);
              return (
                <button
                  type="button"
                  key={iso}
                  className={`${outside ? "outside" : ""} ${selected ? "selected" : ""} ${isToday ? "today" : ""}`}
                  disabled={blocked}
                  onClick={() => chooseDate(iso)}
                  aria-pressed={selected}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="date-popover-actions">
            <button type="button" onClick={setToday}>
              今天
            </button>
            <button type="button" onClick={() => commitValue("")} disabled={required}>
              清空
            </button>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div ref={fieldRef} className={`date-field ${compact ? "compact" : ""} ${!showStepButtons ? "without-step-buttons" : ""} ${className}`}>
      {label && !hideLabel ? <span className="date-field-label">{label}</span> : null}
      {name ? <input type="hidden" name={name} value={selectedValue || ""} /> : null}
      <div className={`date-input-shell ${open ? "open" : ""} ${disabled ? "disabled" : ""}`}>
        {showStepButtons ? (
          <button type="button" className="date-step-button" onClick={() => stepDate(-1)} disabled={disabled} aria-label="前一天">
            <ChevronLeft aria-hidden="true" />
          </button>
        ) : null}
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={draft}
          required={required}
          disabled={disabled}
          pattern="\d{4}-\d{2}-\d{2}"
          placeholder={placeholder}
          aria-label={ariaLabel || label || "日期"}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onFocus={openCalendar}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitDraft();
              closeCalendar();
            }
            if (event.key === "ArrowDown" && (event.altKey || event.metaKey)) {
              event.preventDefault();
              openCalendar();
            }
          }}
        />
        <button type="button" className="date-calendar-button" onClick={open ? closeCalendar : openCalendar} disabled={disabled} aria-label="打开日历">
          <CalendarDays aria-hidden="true" />
        </button>
        {!required && selectedValue ? (
          <button type="button" className="date-clear-button" onClick={() => commitValue("")} disabled={disabled} aria-label="清空日期">
            <X aria-hidden="true" />
          </button>
        ) : null}
        {showStepButtons ? (
          <button type="button" className="date-step-button" onClick={() => stepDate(1)} disabled={disabled} aria-label="后一天">
            <ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {popover}
    </div>
  );
}
