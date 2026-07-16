// Token-level diff for the WhyDrawer's "DAX differences" panel. UI-only (not part of the scored
// engine), so it lives in the app rather than engine/. Produces two aligned token streams: the left
// (A) side marks tokens absent from B as "removed", the right (B) side marks tokens absent from A as
// "added", everything else is "same". A standard LCS keeps the shared skeleton stable so only the
// genuinely-changed tokens light up, instead of the whole expression re-coloring on a small edit.

export type DiffKind = "same" | "removed" | "added";
export interface DiffToken {
  text: string;
  kind: DiffKind;
}

// Split DAX into meaningful units, preserving every character so the tokens re-concatenate to the
// original string: whitespace runs, quoted 'table' names, "string" literals, [column] refs, bare
// identifiers/numbers, then any single operator/punctuation char.
export function tokenizeDax(s: string): string[] {
  return s.match(/\s+|'[^']*'|"[^"]*"|\[[^\]]*\]|[A-Za-z0-9_.]+|[^\s]/g) ?? [];
}

export function diffDax(a: string, b: string): { a: DiffToken[]; b: DiffToken[] } {
  const ta = tokenizeDax(a);
  const tb = tokenizeDax(b);
  const n = ta.length;
  const m = tb.length;

  // LCS length table (row n+1 x m+1), filled bottom-up so we can backtrack from the top-left.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const outA: DiffToken[] = [];
  const outB: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      outA.push({ text: ta[i], kind: "same" });
      outB.push({ text: tb[j], kind: "same" });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      outA.push({ text: ta[i], kind: "removed" });
      i++;
    } else {
      outB.push({ text: tb[j], kind: "added" });
      j++;
    }
  }
  while (i < n) outA.push({ text: ta[i++], kind: "removed" });
  while (j < m) outB.push({ text: tb[j++], kind: "added" });
  return { a: outA, b: outB };
}
