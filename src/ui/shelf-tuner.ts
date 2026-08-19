import {
  rampControls,
  scaleFromU,
  shelfRadiiPx,
  threeShelf,
  type ShelfFieldParams,
} from "../effects/shelf-envelope";

export type ShelfTuner = { destroy: () => void };

export type ShelfTunerOptions = {
  onChange?: () => void;
};

type DragTarget = "inner" | "outer" | "v1" | "v2";

type FieldKey = keyof ShelfFieldParams;

type NumSpec = {
  key: FieldKey;
  label: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
};

const NUMS: NumSpec[] = [
  { key: "innerPct", label: "Width", min: 0, max: 250, step: 1, suffix: "%" },
  { key: "shoulderPct", label: "Ramp", min: 1, max: 250, step: 1, suffix: "%" },
  { key: "maxScale", label: "Center", min: 0.5, max: 1, step: 0.01 },
  { key: "minScale", label: "Edge", min: 0.5, max: 1, step: 0.01 },
  { key: "vx1", label: "V1x", min: 0, max: 1, step: 0.01 },
  { key: "vy1", label: "V1y", min: -1, max: 0.5, step: 0.01 },
  { key: "vx2", label: "V2x", min: -1, max: 0, step: 0.01 },
  { key: "vy2", label: "V2y", min: -0.5, max: 1, step: 0.01 },
];

type PlotGeom = {
  viewW: number;
  xMax: number;
  padX: number;
  padTop: number;
  padBottom: number;
  w: number;
  h: number;
  inner: number;
  outer: number;
  half: number;
  shoulder: number;
  centerS: number;
  edgeS: number;
  yMin: number;
  toX: (x: number) => number;
  toY: (s: number) => number;
  fromX: (px: number) => number;
  fromY: (py: number) => number;
  handles: Record<DragTarget, { x: number; y: number }>;
};

// Top-right scale chart — drag handles + number fields.
export function mountShelfTuner(
  field: ShelfFieldParams,
  options: ShelfTunerOptions = {},
): ShelfTuner {
  const root = document.createElement("div");
  root.className = "shelf-field";
  root.innerHTML = `
    <p class="shelf-field__caption">Scale map</p>
    <div class="shelf-field__body">
      <canvas class="shelf-field__plot" width="520" height="280" aria-label="Scale map"></canvas>
      <div class="shelf-field__nums"></div>
    </div>
  `;

  const plot = root.querySelector<HTMLCanvasElement>(".shelf-field__plot")!;
  const nums = root.querySelector<HTMLElement>(".shelf-field__nums")!;
  const inputs = new Map<FieldKey, HTMLInputElement>();

  const CSS_W = 520;
  const CSS_H = 280;
  let drawW = CSS_W;
  let drawH = CSS_H;

  function syncCanvasDpi() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = plot.getBoundingClientRect();
    drawW = Math.max(1, Math.round(rect.width)) || CSS_W;
    drawH = Math.max(1, Math.round(rect.height)) || CSS_H;
    const bw = Math.round(drawW * dpr);
    const bh = Math.round(drawH * dpr);
    if (plot.width !== bw || plot.height !== bh) {
      plot.width = bw;
      plot.height = bh;
    }
    const ctx = plot.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  for (const spec of NUMS) {
    const label = document.createElement("label");
    label.className = "shelf-field__num";
    label.innerHTML = `
      <span class="shelf-field__num-label">${spec.label}</span>
      <span class="shelf-field__num-wrap">
        <input type="number" inputmode="decimal"
          min="${spec.min}" max="${spec.max}" step="${spec.step}" />
        ${spec.suffix ? `<span class="shelf-field__suffix">${spec.suffix}</span>` : ""}
      </span>
    `;
    const input = label.querySelector("input")!;
    input.value = formatInput(field[spec.key], spec.step);
    inputs.set(spec.key, input);

    input.addEventListener("change", () => commitNumber(spec, input));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitNumber(spec, input);
        input.blur();
      }
    });

    nums.appendChild(label);
  }

  let geom: PlotGeom | null = null;
  let drag: DragTarget | null = null;

  function syncInputsFromField() {
    for (const spec of NUMS) {
      const input = inputs.get(spec.key);
      if (!input || document.activeElement === input) continue;
      input.value = formatInput(field[spec.key], spec.step);
    }
  }

  function commitNumber(spec: NumSpec, input: HTMLInputElement) {
    let n = Number(input.value);
    if (!Number.isFinite(n)) n = field[spec.key];
    n = clamp(n, spec.min, spec.max);
    if (spec.step >= 1) n = Math.round(n);
    else n = Math.round(n / spec.step) * spec.step;
    field[spec.key] = n;
    input.value = formatInput(n, spec.step);
    redraw();
  }

  // line up plot with input underlines
  function measurePlotPads(): { padTop: number; padBottom: number; padX: number } {
    const wraps = nums.querySelectorAll<HTMLElement>(".shelf-field__num-wrap");
    const first = wraps[0];
    const last = wraps[wraps.length - 1];
    const fallback = { padTop: 14, padBottom: 18, padX: 28 };
    if (!first || !last) return fallback;

    const canvasRect = plot.getBoundingClientRect();
    if (canvasRect.height < 8) return fallback;

    const scaleY = drawH / canvasRect.height;
    const padTop = (first.getBoundingClientRect().bottom - canvasRect.top) * scaleY;
    const padBottom = (canvasRect.bottom - last.getBoundingClientRect().bottom) * scaleY;

    return {
      padTop: clamp(padTop, 6, drawH * 0.35),
      padBottom: clamp(padBottom, 6, drawH * 0.35),
      padX: 28,
    };
  }

  function redraw() {
    syncCanvasDpi();
    const pads = measurePlotPads();
    geom = buildGeom(drawW, drawH, field, pads);
    drawPlot(plot, field, geom);
    syncInputsFromField();
    options.onChange?.();
  }

  function hitHandle(px: number, py: number): DragTarget | null {
    if (!geom) return null;
    const order: DragTarget[] = ["v1", "v2", "inner", "outer"];
    const r = 14;
    for (const id of order) {
      const h = geom.handles[id];
      const dx = px - h.x;
      const dy = py - h.y;
      if (dx * dx + dy * dy <= r * r) return id;
    }
    return null;
  }

  function canvasPos(e: PointerEvent) {
    const rect = plot.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * drawW,
      y: ((e.clientY - rect.top) / rect.height) * drawH,
    };
  }

  function applyDrag(id: DragTarget, px: number, py: number) {
    if (!geom) return;
    const x = geom.fromX(px);
    const s = clamp(geom.fromY(py), 0, 1);
    const centerS = clamp(field.maxScale, 0.5, 1);
    const edgeS = clamp(field.minScale, 0.5, 1);
    const span = centerS - edgeS;

    if (id === "inner") {
      field.innerPct = clamp((x / geom.half) * 100, 0, 250);
      if (field.shoulderPct < 1) field.shoulderPct = 1;
      field.maxScale = clamp(s, 0.5, 1);
    } else if (id === "outer") {
      const inner = (field.innerPct / 100) * geom.half;
      const shoulderPx = Math.max(1, x - inner);
      field.shoulderPct = clamp((shoulderPx / geom.half) * 100, 1, 250);
      field.minScale = clamp(s, 0.5, 1);
    } else if (id === "v1") {
      const t = geom.shoulder > 1e-6 ? (x - geom.inner) / geom.shoulder : 0;
      field.vx1 = clamp(t, 0, 1);
      const u = Math.abs(span) < 1e-6 ? 1 : clamp((s - edgeS) / span, 0, 1);
      field.vy1 = clamp(u - 1, -1, 0.5);
    } else if (id === "v2") {
      const t = geom.shoulder > 1e-6 ? (x - geom.inner) / geom.shoulder : 1;
      field.vx2 = clamp(t - 1, -1, 0);
      const u = Math.abs(span) < 1e-6 ? 0 : clamp((s - edgeS) / span, 0, 1);
      field.vy2 = clamp(u, -0.5, 1);
    }
  }

  plot.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = canvasPos(e);
    drag = hitHandle(x, y);
    if (!drag) return;
    plot.setPointerCapture(e.pointerId);
    plot.classList.add("is-dragging");
    applyDrag(drag, x, y);
    redraw();
  });

  plot.addEventListener("pointermove", (e) => {
    if (!drag) {
      const { x, y } = canvasPos(e);
      plot.style.cursor = hitHandle(x, y) ? "grab" : "default";
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = canvasPos(e);
    applyDrag(drag, x, y);
    redraw();
  });

  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    drag = null;
    plot.classList.remove("is-dragging");
    try {
      plot.releasePointerCapture(e.pointerId);
    } catch {
      /* */
    }
  };
  plot.addEventListener("pointerup", endDrag);
  plot.addEventListener("pointercancel", endDrag);

  root.addEventListener("pointerdown", (e) => e.stopPropagation());
  root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  const onResize = () => redraw();
  window.addEventListener("resize", onResize);

  document.body.appendChild(root);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => redraw()); // layout → measure underlines
  });

  return {
    destroy: () => {
      window.removeEventListener("resize", onResize);
      root.remove();
    },
  };
}

function formatInput(n: number, step: number): string {
  if (step >= 1) return String(Math.round(n));
  const decimals = String(step).includes(".") ? String(step).split(".")[1]!.length : 2;
  return n.toFixed(decimals);
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function buildGeom(
  cssW: number,
  cssH: number,
  field: ShelfFieldParams,
  pads: { padTop: number; padBottom: number; padX: number },
): PlotGeom {
  const viewW =
    document.querySelector<HTMLElement>("[data-gallery-scroller]")?.clientWidth ||
    window.innerWidth;
  const { inner, outer, half } = shelfRadiiPx(field, viewW);
  const shoulder = outer - inner;
  const centerS = clamp(field.maxScale, 0.5, 1);
  const edgeS = clamp(field.minScale, 0.5, 1);
  const yMin = 0.5;
  const xMax = Math.max(outer * 1.18, half * 1.1, 80);
  const { padX, padTop, padBottom } = pads;
  const w = cssW;
  const h = cssH;

  const toX = (x: number) => padX + (x / xMax) * (w - padX * 2);
  const toY = (s: number) => {
    const t = (clamp(s, yMin, 1) - yMin) / (1 - yMin);
    return padTop + (1 - t) * (h - padTop - padBottom);
  };
  const fromX = (px: number) => ((px - padX) / (w - padX * 2)) * xMax;
  const fromY = (py: number) => {
    const t = 1 - (py - padTop) / (h - padTop - padBottom);
    return yMin + clamp(t, 0, 1) * (1 - yMin);
  };

  const { p1x, p1y, p2x, p2y } = rampControls(field);
  const s1 = scaleFromU(p1y, field);
  const s2 = scaleFromU(p2y, field);

  return {
    viewW,
    xMax,
    padX,
    padTop,
    padBottom,
    w,
    h,
    inner,
    outer,
    half,
    shoulder,
    centerS,
    edgeS,
    yMin,
    toX,
    toY,
    fromX,
    fromY,
    handles: {
      inner: { x: toX(inner), y: toY(centerS) },
      outer: { x: toX(outer), y: toY(edgeS) },
      v1: { x: toX(inner + shoulder * p1x), y: toY(s1) },
      v2: { x: toX(inner + shoulder * p2x), y: toY(s2) },
    },
  };
}

function px(n: number): number {
  return Math.round(n) + 0.5;
}

function drawPlot(canvas: HTMLCanvasElement, field: ShelfFieldParams, geom: PlotGeom): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { w, h, padX, padTop, padBottom, toX, toY, half, inner, outer, centerS, edgeS, yMin, viewW, handles, xMax } =
    geom;

  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;

  const plotL = padX;
  const plotR = w - padX;
  const plotT = padTop;
  const plotB = h - padBottom;
  const overhang = 7;

  ctx.strokeStyle = "rgb(20 22 26 / 0.16)";
  ctx.lineWidth = 1;
  ctx.strokeRect(px(plotL), px(plotT), plotR - plotL, plotB - plotT);

  ctx.strokeStyle = "rgb(20 22 26 / 0.07)";
  ctx.lineWidth = 1;
  const xTicks = 8;
  const yTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const x = px(plotL + ((plotR - plotL) * i) / xTicks);
    ctx.beginPath();
    ctx.moveTo(x, plotT - overhang);
    ctx.lineTo(x, plotB + overhang);
    ctx.stroke();
  }
  for (let i = 0; i <= yTicks; i++) {
    const y = px(plotT + ((plotB - plotT) * i) / yTicks);
    ctx.beginPath();
    ctx.moveTo(plotL - overhang, y);
    ctx.lineTo(plotR + overhang, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgb(20 22 26 / 0.18)";
  for (const s of [centerS, edgeS, yMin]) {
    const y = px(toY(s));
    ctx.beginPath();
    ctx.moveTo(plotL - overhang, y);
    ctx.lineTo(plotR + overhang, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgb(15 110 106 / 0.4)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(px(toX(half)), plotT - overhang);
  ctx.lineTo(px(toX(half)), plotB + overhang);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = "rgb(20 22 26 / 0.22)";
  ctx.beginPath();
  ctx.moveTo(px(toX(inner)), plotT - overhang);
  ctx.lineTo(px(toX(inner)), plotB + overhang);
  ctx.moveTo(px(toX(outer)), plotT - overhang);
  ctx.lineTo(px(toX(outer)), plotB + overhang);
  ctx.stroke();

  ctx.beginPath();
  for (let i = 0; i <= 160; i++) {
    const x = (i / 160) * xMax;
    const s = scaleFromU(threeShelf(x, field, viewW), field);
    const cx = toX(x);
    const cy = toY(s);
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.strokeStyle = "#0f6e6a";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.strokeStyle = "rgb(180 140 50 / 0.7)";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(handles.inner.x, handles.inner.y);
  ctx.lineTo(handles.v1.x, handles.v1.y);
  ctx.moveTo(handles.outer.x, handles.outer.y);
  ctx.lineTo(handles.v2.x, handles.v2.y);
  ctx.stroke();

  const drawHandle = (p: { x: number; y: number }, fill: string) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "#14161a";
    ctx.lineWidth = 1.25;
    ctx.stroke();
  };

  drawHandle(handles.inner, "#0f6e6a");
  drawHandle(handles.outer, "#0f6e6a");
  drawHandle(handles.v1, "#c49a3c");
  drawHandle(handles.v2, "#c49a3c");

  ctx.fillStyle = "#5c636e";
  ctx.font = "11px Fragment Mono, ui-monospace, monospace";
  ctx.fillText(centerS.toFixed(2), 4, toY(centerS) + 4);
  if (Math.abs(edgeS - centerS) > 0.02 && Math.abs(edgeS - yMin) > 0.02) {
    ctx.fillText(edgeS.toFixed(2), 4, toY(edgeS) + 4);
  }
  ctx.fillText(yMin.toFixed(1), 4, toY(yMin) + 4);
  ctx.fillText("edge", Math.min(toX(half) + 6, w - 42), Math.min(h - 4, plotB + overhang + 11));
}
