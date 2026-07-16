import { describe, expect, it } from "vitest";
import { diffDax, tokenizeDax } from "../daxDiff";

describe("daxDiff", () => {
  it("tokenizes DAX preserving table[column], quotes, and whitespace", () => {
    expect(tokenizeDax("SUM(Sales[Amount])").join("|")).toBe("SUM|(|Sales|[Amount]|)");
    expect(tokenizeDax("SUM('My Table'[Amt])").join("|")).toBe("SUM|(|'My Table'|[Amt]|)");
    // Round-trips: joining the tokens reproduces the original string exactly.
    const s = "CALCULATE( SUM(Sales[Amt]), Sales[Region] = \"EU\" )";
    expect(tokenizeDax(s).join("")).toBe(s);
  });

  it("marks identical DAX as all same (no removed/added)", () => {
    const { a, b } = diffDax("SUM(Sales[Amount])", "SUM(Sales[Amount])");
    expect(a.every((t) => t.kind === "same")).toBe(true);
    expect(b.every((t) => t.kind === "same")).toBe(true);
  });

  it("flags only the changed tokens on each side", () => {
    // Same shape, different aggregated column: Amount -> Revenue.
    const { a, b } = diffDax("SUM(Sales[Amount])", "SUM(Sales[Revenue])");
    const removed = a.filter((t) => t.kind === "removed").map((t) => t.text);
    const added = b.filter((t) => t.kind === "added").map((t) => t.text);
    expect(removed).toContain("[Amount]");
    expect(added).toContain("[Revenue]");
    // The shared skeleton stays "same" on both sides.
    expect(a.filter((t) => t.kind === "same").map((t) => t.text)).toEqual(["SUM", "(", "Sales", ")"]);
    expect(b.filter((t) => t.kind === "same").map((t) => t.text)).toEqual(["SUM", "(", "Sales", ")"]);
  });

  it("treats one empty side as fully added", () => {
    const { a, b } = diffDax("", "SUM(Sales[Amount])");
    expect(a).toHaveLength(0);
    expect(b.every((t) => t.kind === "added")).toBe(true);
  });
});
