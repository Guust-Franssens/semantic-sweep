import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { ModelCard, PairResult } from "@engine/types";
import { modelId } from "@engine/types";
import { bandLabel, bandRgbTable } from "./bands";

interface Props {
  cards: ModelCard[];
  pairs: PairResult[];
  labels: Map<string, string>;
  onSelect: (p: PairResult) => void;
  onModel?: (c: ModelCard) => void;
}

interface Hover {
  r: number;
  c: number;
  p?: PairResult;
  x: number;
  y: number;
}

// Canvas heatmap: the previous N×N <table> rendered one <td> per pair, which freezes the browser
// on large estates (a 400-model scan = 160k DOM cells). A single <canvas> draws the whole grid in
// one paint, scales cell size to fit, and adds a row/column crosshair on hover.
export function Heatmap({ cards, pairs, labels, onSelect, onModel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverRef = useRef<Hover | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const { lookup, codes, ids } = useMemo(() => {
    const lookup = new Map<string, PairResult>();
    for (const p of pairs) lookup.set([modelId(p.a), modelId(p.b)].sort().join("|"), p);
    const codes = cards.map((_, i) => `M${String(i + 1).padStart(2, "0")}`);
    const ids = cards.map((c) => modelId(c));
    return { lookup, codes, ids };
  }, [cards, pairs]);

  const n = cards.length;
  const gutter = 42; // room for M01… row/col labels
  const cap = 1600; // keep the widest grid scrollable, not gigantic
  const cell = Math.max(1, Math.min(20, Math.floor((cap - gutter) / Math.max(1, n))));
  const size = gutter + n * cell;
  // Bound the backing-store memory on very large grids (a 1600px grid at DPR 2 is already ~40 MB).
  const dpr = size > 1100 ? 1 : Math.min(2, window.devicePixelRatio || 1);

  function pairAt(r: number, c: number): PairResult | undefined {
    if (r === c) return undefined;
    return lookup.get([ids[r], ids[c]].sort().join("|"));
  }

  function draw(h: Hover | null): void {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const cs = getComputedStyle(canvas);
    const accentRgb = cs.getPropertyValue("--cp-accent-rgb").trim() || "99,102,241";
    const accent = cs.getPropertyValue("--cp-accent").trim() || "#6366f1";
    const border = cs.getPropertyValue("--cp-border").trim() || "#e5e7eb";
    const softbg = cs.getPropertyValue("--cp-surface-soft").trim() || "#f3f4f6";
    const muted = cs.getPropertyValue("--cp-text-muted").trim() || "#6b7280";
    // Per-band hue so identity (exact clone vs related-source, etc.) reads at a glance instead of
    // just headline-score opacity of a single accent color — matches the legend shown above the grid.
    const rgbByBand = bandRgbTable(canvas);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = gutter + c * cell;
        const y = gutter + r * cell;
        if (r === c) {
          ctx.fillStyle = softbg;
          ctx.fillRect(x, y, cell, cell);
          continue;
        }
        const p = pairAt(r, c);
        const score = p ? p.headline : 0;
        if (p && score > 0) {
          const rgb = rgbByBand[p.band] ?? rgbByBand.unrelated ?? accentRgb;
          ctx.fillStyle = `rgba(${rgb}, ${0.08 + 0.92 * score})`;
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }

    if (cell >= 4) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const g = gutter + i * cell + 0.5;
        ctx.moveTo(gutter, g);
        ctx.lineTo(gutter + n * cell, g);
        ctx.moveTo(g, gutter);
        ctx.lineTo(g, gutter + n * cell);
      }
      ctx.stroke();
    }

    if (cell >= 12) {
      ctx.fillStyle = muted;
      ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
      ctx.textBaseline = "middle";
      for (let i = 0; i < n; i++) {
        ctx.textAlign = "right";
        ctx.fillText(codes[i], gutter - 4, gutter + i * cell + cell / 2);
        ctx.save();
        ctx.translate(gutter + i * cell + cell / 2, gutter - 4);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "left";
        ctx.fillText(codes[i], 0, 0);
        ctx.restore();
      }
    }

    if (h && h.r !== h.c) {
      ctx.fillStyle = `rgba(${accentRgb}, 0.12)`;
      ctx.fillRect(gutter, gutter + h.r * cell, n * cell, cell);
      ctx.fillRect(gutter + h.c * cell, gutter, cell, n * cell);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(gutter + h.c * cell + 1, gutter + h.r * cell + 1, cell - 2, cell - 2);
    }
  }

  // Redraw on data change, and again whenever the theme flips (colors are read from CSS vars).
  useEffect(() => {
    draw(hoverRef.current);
    const obs = new MutationObserver(() => draw(hoverRef.current));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, pairs, size, cell, dpr]);

  function locate(e: ReactMouseEvent<HTMLCanvasElement>): Hover | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - gutter;
    const py = e.clientY - rect.top - gutter;
    if (px < 0 || py < 0) return null;
    const c = Math.floor(px / cell);
    const r = Math.floor(py / cell);
    if (r < 0 || r >= n || c < 0 || c >= n) return null;
    return { r, c, p: pairAt(r, c), x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onMove(e: ReactMouseEvent<HTMLCanvasElement>): void {
    const h = locate(e);
    const prev = hoverRef.current;
    hoverRef.current = h;
    setHover(h);
    // Only repaint the canvas when the hovered cell actually changes (not on every pixel).
    if (!h || !prev || h.r !== prev.r || h.c !== prev.c) draw(h);
  }

  function onLeave(): void {
    hoverRef.current = null;
    setHover(null);
    draw(null);
  }

  function onClick(): void {
    const h = hoverRef.current;
    if (h?.p) onSelect(h.p);
  }

  // Cell-center position in the same CSS-px space `locate()` uses for mouse hover, so keyboard
  // focus reuses the existing crosshair/tooltip rendering without a parallel code path.
  function hoverFor(r: number, c: number): Hover {
    return { r, c, p: pairAt(r, c), x: gutter + c * cell + cell / 2, y: gutter + r * cell + cell / 2 };
  }

  function moveFocus(dr: number, dc: number): void {
    if (n === 0) return;
    const prev = hoverRef.current ?? { r: 0, c: n > 1 ? 1 : 0 };
    let r = Math.min(n - 1, Math.max(0, prev.r + dr));
    let c = Math.min(n - 1, Math.max(0, prev.c + dc));
    // A model is never scored against itself — step one further in the direction of travel to
    // hop over the diagonal instead of landing on a cell that can never have a pair.
    if (r === c) {
      if (dr !== 0) r = Math.min(n - 1, Math.max(0, r + dr));
      else if (dc !== 0) c = Math.min(n - 1, Math.max(0, c + dc));
    }
    const h = hoverFor(r, c);
    hoverRef.current = h;
    setHover(h);
    draw(h);
  }

  const KEY_MOVES: Record<string, [number, number]> = {
    ArrowRight: [0, 1],
    ArrowLeft: [0, -1],
    ArrowDown: [1, 0],
    ArrowUp: [-1, 0],
  };

  function onKeyDown(e: ReactKeyboardEvent<HTMLCanvasElement>): void {
    const move = KEY_MOVES[e.key];
    if (move) {
      e.preventDefault();
      moveFocus(move[0], move[1]);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (hoverRef.current?.p) onSelect(hoverRef.current.p);
    }
  }

  // Text for the visually-hidden aria-live region — mirrors the mouse tooltip's content so keyboard
  // and screen-reader users get the same row/column/band/score info sighted mouse users see.
  function describeHover(h: Hover): string {
    const rowName = labels.get(ids[h.r]) ?? codes[h.r];
    const colName = labels.get(ids[h.c]) ?? codes[h.c];
    const band = h.p ? bandLabel(h.p.band) : "Unrelated";
    const score = (h.p ? h.p.headline : 0).toFixed(2);
    return `${codes[h.r]} ${rowName} and ${codes[h.c]} ${colName}: ${band}, score ${score}.`;
  }

  return (
    <div>
      <div className="heatmap-wrap">
        <div className="heatmap-canvas-wrap" style={{ width: size, height: size }}>
          <canvas
            ref={canvasRef}
            width={size * dpr}
            height={size * dpr}
            tabIndex={0}
            role="img"
            aria-label={`Model similarity heatmap, ${n} by ${n} models. Focus and use arrow keys to move between cells, Enter to inspect a pair. The focused cell is announced below.`}
            aria-describedby="hm-live"
            style={{ width: size, height: size, cursor: hover?.p ? "pointer" : "default" }}
            onMouseMove={onMove}
            onMouseLeave={onLeave}
            onFocus={() => moveFocus(0, 0)}
            onBlur={onLeave}
            onKeyDown={onKeyDown}
            onClick={onClick}
          />
          {hover && hover.r !== hover.c && (
            <div
              className="hm-tip"
              style={{ left: Math.min(hover.x + 14, Math.max(4, size - 210)), top: hover.y + 14 }}
            >
              <div>
                <strong>{codes[hover.r]}</strong> {labels.get(ids[hover.r])}
              </div>
              <div>
                <strong>{codes[hover.c]}</strong> {labels.get(ids[hover.c])}
              </div>
              <div className="hm-tip-band">
                {hover.p ? bandLabel(hover.p.band) : "unrelated"} · score {(hover.p ? hover.p.headline : 0).toFixed(2)}
              </div>
            </div>
          )}
        </div>
        <div id="hm-live" className="sr-only" aria-live="polite" aria-atomic="true">
          {hover && hover.r !== hover.c ? describeHover(hover) : ""}
        </div>
      </div>
      <details className="tag">
        <summary>Model index ({cards.length})</summary>
        <ul className="plain" style={{ columns: 2 }}>
          {cards.map((c, i) => (
            <li key={modelId(c)}>
              <span className="mono" style={{ color: "var(--cp-accent)" }}>
                {codes[i]}
              </span>{" "}
              {onModel ? (
                <button className="mi-btn" onClick={() => onModel(c)}>
                  {labels.get(modelId(c))}
                </button>
              ) : (
                labels.get(modelId(c))
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
