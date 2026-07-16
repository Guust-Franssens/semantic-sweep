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

// Extracts the bare custom-property name from a `var(--x)` reference, e.g. "var(--cp-danger)" -> "--cp-danger".
function varName(cssColor: string): string | null {
  const m = /var\((--[\w-]+)\)/.exec(cssColor);
  return m ? m[1] : null;
}

// Parses a #rgb/#rrggbb hex color into an "r,g,b" triple for use inside a canvas rgba(...) fill.
// Falls back to a neutral gray if the input isn't a recognizable hex color (e.g. an unresolved CSS
// var), so a bad/missing token degrades gracefully instead of throwing mid-paint.
export function hexToRgb(hex: string): string {
  const s = hex.trim().replace(/^#/, "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  const n = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return "107,114,128";
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(",");
}

// Resolves every band's CSS color var against the given element's computed style, for use as canvas
// rgba() fills (the heatmap paints via 2D context, not DOM, so it can't rely on `background: var(...)`
// like the rest of the UI). Lets the heatmap encode band identity by hue — not just headline score by
// opacity of a single accent hue — while staying driven by the same BAND_META the legend/pills use.
export function bandRgbTable(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const table: Record<string, string> = {};
  for (const [band, meta] of Object.entries(BAND_META)) {
    const name = varName(meta.color);
    const resolved = name ? cs.getPropertyValue(name).trim() : "";
    table[band] = hexToRgb(resolved || "#6b7280");
  }
  return table;
}
