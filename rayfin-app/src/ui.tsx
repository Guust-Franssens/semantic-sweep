import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function Card({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cn("rounded-2xl border border-border bg-card text-card-foreground", className)} style={style}>
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{children}</div>;
}

// FabricAtlas-style KPI: a lucide icon in a tinted rounded square + big number + label.
export function StatCard({
  icon: Icon,
  value,
  label,
  sub,
  tint = "#0f6cbd",
  accent,
}: {
  icon: LucideIcon;
  value: ReactNode;
  label: string;
  sub?: string;
  tint?: string;
  accent?: boolean;
}) {
  return (
    <Card className="p-[14px]">
      <div className="flex items-start gap-[11px]">
        <span
          className="flex items-center justify-center rounded-lg"
          style={{ width: 34, height: 34, background: `${tint}1f`, color: tint }}
        >
          <Icon size={18} />
        </span>
        <div className="min-w-0">
          <div className="text-[24px] font-bold leading-none" style={accent ? { color: tint } : undefined}>
            {value}
          </div>
          <div className="mt-[5px] text-[12.5px] font-semibold text-foreground">{label}</div>
          {sub && <div className="mt-[1px] text-[11px] text-muted-foreground">{sub}</div>}
        </div>
      </div>
    </Card>
  );
}

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  const initials = name
    .split(/[ @._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: `hsl(${h} 45% 45%)`, fontSize: Math.round(size * 0.4) }}
    >
      {initials || "?"}
    </span>
  );
}
