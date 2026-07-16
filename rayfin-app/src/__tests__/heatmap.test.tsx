import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scorePair } from "@engine/index";
import type { ModelCard } from "@engine/types";
import { modelId } from "@engine/types";
import { bandRgbTable } from "../bands";
import { Heatmap } from "../Heatmap";

const base: ModelCard = {
  name: "Sales",
  workspace: "Prod",
  tables: ["Sales"],
  columns: [],
  measures: [{ name: "Total", dax: "SUM(Sales[Amount])" }],
  relationships: [],
  sourceLogical: new Set(["dbo\u0000Sales"]),
  sourcePhysical: new Set(["srv\u0000db"]),
  hasRls: false,
  hasCalcGroups: false,
  systemGenerated: false,
};

function makeCards(): ModelCard[] {
  const a: ModelCard = { ...base, name: "SalesA" };
  const b: ModelCard = { ...base, name: "SalesB" }; // identical to a -> scores high
  const c: ModelCard = {
    ...base,
    name: "Unrelated",
    measures: [{ name: "Different", dax: "1+1" }],
    sourceLogical: new Set(["x\u0000y"]),
    sourcePhysical: new Set(["z\u0000w"]),
  };
  return [a, b, c];
}

function labelsFor(cards: ModelCard[]): Map<string, string> {
  return new Map(cards.map((c) => [modelId(c), c.name]));
}

// jsdom doesn't implement canvas 2D rendering; stub just enough of the API for Heatmap's draw() to
// run without throwing, and record each fillRect call's fillStyle so tests can assert on paint color.
function stubCanvasContext(): { fillCalls: string[] } {
  const fillCalls: string[] = [];
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(function (this: { fillStyle: string }) {
      fillCalls.push(this.fillStyle);
    }),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return { fillCalls };
}

describe("Heatmap — per-band color encoding (P2 a11y)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills each pair's cell using that pair's own band color, not one fixed hue for everything", () => {
    const { fillCalls } = stubCanvasContext();
    const cards = makeCards(); // [SalesA, SalesB (identical), Unrelated (near-nothing in common)]
    const abPair = scorePair(cards[0], cards[1]);
    const acPair = scorePair(cards[0], cards[2]);
    render(
      <Heatmap
        cards={cards}
        pairs={[abPair, acPair, scorePair(cards[1], cards[2])]}
        labels={labelsFor(cards)}
        onSelect={() => {}}
      />,
    );
    const rgbByBand = bandRgbTable(document.documentElement);
    // The two pairs score very differently, so (if per-band coloring works) they land in different
    // bands and are therefore expected to paint in different hues rather than one shared accent color.
    expect(abPair.band).not.toBe(acPair.band);
    expect(fillCalls.some((s) => s.startsWith(`rgba(${rgbByBand[abPair.band]},`))).toBe(true);
    expect(fillCalls.some((s) => s.startsWith(`rgba(${rgbByBand[acPair.band]},`))).toBe(true);
  });
});

describe("Heatmap — keyboard navigation + ARIA (P2 a11y)", () => {
  beforeEach(() => {
    stubCanvasContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is focusable and exposes a descriptive aria-label pointing at the live region", () => {
    const cards = makeCards();
    const pairs = [scorePair(cards[0], cards[1]), scorePair(cards[0], cards[2]), scorePair(cards[1], cards[2])];
    render(<Heatmap cards={cards} pairs={pairs} labels={labelsFor(cards)} onSelect={() => {}} />);
    const canvas = screen.getByRole("img");
    expect(canvas).toHaveAttribute("tabIndex", "0");
    expect(canvas.getAttribute("aria-label")).toMatch(/heatmap/i);
    expect(canvas.getAttribute("aria-describedby")).toBe("hm-live");
    expect(document.getElementById("hm-live")).not.toBeNull();
  });

  it("moves focus between cells with arrow keys and announces the focused pair in the live region", () => {
    const cards = makeCards();
    const pairs = [scorePair(cards[0], cards[1]), scorePair(cards[0], cards[2]), scorePair(cards[1], cards[2])];
    render(<Heatmap cards={cards} pairs={pairs} labels={labelsFor(cards)} onSelect={() => {}} />);
    const canvas = screen.getByRole("img");
    fireEvent.focus(canvas);
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    const live = document.getElementById("hm-live");
    expect(live?.textContent).toMatch(/SalesA|SalesB|Unrelated/);
    expect(live?.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("invokes onSelect for the focused pair on Enter", () => {
    const cards = makeCards().slice(0, 2);
    const pairs = [scorePair(cards[0], cards[1])];
    const onSelect = vi.fn();
    render(<Heatmap cards={cards} pairs={pairs} labels={labelsFor(cards)} onSelect={onSelect} />);
    const canvas = screen.getByRole("img");
    fireEvent.focus(canvas); // focuses the only off-diagonal cell (0,1)
    fireEvent.keyDown(canvas, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(pairs[0]);
  });

  it("clears the live-region announcement on blur, same as mouse leave", () => {
    const cards = makeCards().slice(0, 2);
    const pairs = [scorePair(cards[0], cards[1])];
    render(<Heatmap cards={cards} pairs={pairs} labels={labelsFor(cards)} onSelect={() => {}} />);
    const canvas = screen.getByRole("img");
    fireEvent.focus(canvas);
    expect(document.getElementById("hm-live")?.textContent).not.toBe("");
    fireEvent.blur(canvas);
    expect(document.getElementById("hm-live")?.textContent).toBe("");
  });
});
