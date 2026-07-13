import { REC_LABELS, SHOWS_SAVINGS } from "@engine/recommend";
import { modelId, type Recommendation } from "@engine/types";

const CSV_HEADERS = [
  "Action", "Model", "Model workspace", "Keeper", "Keeper workspace",
  "Reason", "Blockers", "Savings (refresh min/yr)", "Confidence", "Owner", "Status",
];

// RFC-4180 cell: wrap in quotes and double any embedded quotes so commas/newlines survive Excel.
const csvCell = (v: string | number): string => `"${String(v ?? "").replace(/"/g, '""')}"`;

// Serialize the consolidation worklist (incl. each row's human decision Status) to CSV so decisions
// can be saved/shared with workspace owners — the status is otherwise ephemeral React state.
export function recsToCsv(recs: Recommendation[], status: Record<string, string>): string {
  const rows = recs.map((r) =>
    [
      REC_LABELS[r.action],
      r.member.name,
      r.member.workspace,
      r.keeper?.name ?? "",
      r.keeper?.workspace ?? "",
      r.reasonCodes.join("; "),
      r.blockers.join("; "),
      SHOWS_SAVINGS.has(r.action) ? r.savingsRefreshMinPerYear : "",
      r.confidence.overall.toFixed(2),
      r.member.usage?.configuredBy ?? "",
      status[modelId(r.member)] ?? "Proposed",
    ]
      .map(csvCell)
      .join(","),
  );
  // Lead with a UTF-8 BOM so Excel renders accented owner/model names correctly.
  return "\uFEFF" + [CSV_HEADERS.map(csvCell).join(","), ...rows].join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
