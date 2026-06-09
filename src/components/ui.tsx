import type { ReactNode } from "react";

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
