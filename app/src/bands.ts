// Band → human label + Clawpilot color var.
export const BAND_META: Record<string, { label: string; color: string }> = {
  "exact-clone": { label: "Exact clone", color: "var(--cp-danger)" },
  "strong-duplicate": { label: "Strong duplicate", color: "var(--cp-accent)" },
  subset: { label: "Subset", color: "var(--cp-warning)" },
  "needs-review": { label: "Needs review", color: "var(--cp-warning)" },
  "related-source": { label: "Related source", color: "var(--cp-text-soft)" },
  unrelated: { label: "Unrelated", color: "var(--cp-border-strong)" },
};

export const bandLabel = (b: string): string => BAND_META[b]?.label ?? b;
export const bandColor = (b: string): string => BAND_META[b]?.color ?? "var(--cp-text)";
