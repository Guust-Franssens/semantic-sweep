// Human labels for the saved-scan history's mode chip (SavedScansPanel in pages/SweepPage.tsx).
// Split out from SweepPage so this pure mapping is trivially unit-testable without pulling in that
// page's auth/router/Fabric-client dependency chain.

// The stored value is one of the internal SaveScanMeta tokens ('tenant' | 'admin' | 'zip' | 'usage'
// | the modeFromLabel() fallback 'scan') — shown raw, a user sees an unexplained abbreviation like
// "ZIP" with no context; map each to a short, human phrase instead.
const MODE_CHIP_LABEL: Record<string, string> = {
  admin: "Admin scan",
  tenant: "Per-user scan",
  zip: "Imported",
  usage: "Usage fused",
  scan: "Scan",
};

export function modeChipLabel(mode: string): string {
  return MODE_CHIP_LABEL[mode] ?? mode;
}
