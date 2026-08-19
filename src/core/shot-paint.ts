// Bake `.shot` tiles → canvas textures (photo cover + peel text).

let captionMeasureCtx: CanvasRenderingContext2D | null = null;

function captionMeasureContext(): CanvasRenderingContext2D {
  if (!captionMeasureCtx) {
    const c = document.createElement("canvas");
    captionMeasureCtx = c.getContext("2d");
    if (!captionMeasureCtx) throw new Error("captionMeasure: 2d unavailable");
  }
  return captionMeasureCtx;
}

// Match GL font metrics for a peel-text node.
export function applyPaintFont(ctx: CanvasRenderingContext2D, node: HTMLElement) {
  const cs = getComputedStyle(node);
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.letterSpacing =
    cs.letterSpacing && cs.letterSpacing !== "normal" ? cs.letterSpacing : "0px";
  ctx.fillStyle = cs.color;
}

export function measurePaintTextWidth(node: HTMLElement): number {
  const ctx = captionMeasureContext();
  applyPaintFont(ctx, node);
  return ctx.measureText(node.textContent?.trim() ?? "").width;
}

export type PeelSelectionRect = {
  left: number;
  top: number;
  w: number;
  h: number;
};

export type PeelTextSelection = {
  node: HTMLElement;
  rects: PeelSelectionRect[];
};

function textOffsetInElement(element: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(container, offset);
  return range.toString().length;
}

function parseLineHeight(raw: string, fontSize: number): number {
  if (!raw || raw === "normal") return fontSize * 1.2;
  if (raw.endsWith("px")) return parseFloat(raw) || fontSize;
  const unitless = parseFloat(raw);
  return Number.isFinite(unitless) ? unitless * fontSize : fontSize;
}

function peelSelectionColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--peel-selection").trim();
  return v || "rgb(0 122 255 / 0.45)";
}

function selectionLineRect(
  node: HTMLElement,
  box: { left: number; top: number; w: number; h: number },
  x0: number,
  glyphW: number,
): PeelSelectionRect {
  const cs = getComputedStyle(node);
  const fontSize = parseFloat(cs.fontSize) || 16;
  const lineHeight = parseLineHeight(cs.lineHeight, fontSize);
  const padX = Math.max(2, Math.round(fontSize * 0.07));
  const baselineY = box.top + box.h;

  return {
    left: box.left + x0 - padX,
    top: baselineY - lineHeight,
    w: glyphW + padX * 2,
    h: lineHeight,
  };
}

function rangeIntersectsNode(range: Range, node: HTMLElement): boolean {
  const nodeRange = document.createRange();
  nodeRange.selectNodeContents(node);
  return (
    range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0
  );
}

function selectionOffsetsInTextNode(
  node: HTMLElement,
  range: Range,
): { a: number; b: number } | null {
  if (!rangeIntersectsNode(range, node)) return null;

  const text = node.textContent ?? "";
  const nodeRange = document.createRange();
  nodeRange.selectNodeContents(node);

  let a = 0;
  let b = text.length;

  if (range.compareBoundaryPoints(Range.START_TO_START, nodeRange) > 0) {
    a = textOffsetInElement(node, range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, nodeRange) < 0) {
    b = textOffsetInElement(node, range.endContainer, range.endOffset);
  }

  a = Math.max(0, Math.min(a, text.length));
  b = Math.max(0, Math.min(b, text.length));
  if (a >= b) return null;
  return { a, b };
}

export function selectionRectsInTextNode(
  node: HTMLElement,
  shot: HTMLElement,
  range: Range,
): PeelSelectionRect[] {
  const span = selectionOffsetsInTextNode(node, range);
  if (!span) return [];

  const text = node.textContent ?? "";
  const box = peelTextLayoutBox(node, shot);
  const ctx = captionMeasureContext();
  applyPaintFont(ctx, node);
  const x0 = ctx.measureText(text.slice(0, span.a)).width;
  const w = ctx.measureText(text.slice(span.a, span.b)).width;
  if (w < 0.5) return [];
  return [selectionLineRect(node, box, x0, w)];
}

export function buildShotTextSelection(shot: HTMLElement, range?: Range): PeelTextSelection[] {
  const sel = document.getSelection();
  const activeRange =
    range ?? (sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.getRangeAt(0) : null);
  if (!activeRange) return [];

  const out: PeelTextSelection[] = [];
  for (const node of shot.querySelectorAll<HTMLElement>("[data-peel-text]")) {
    const rects = selectionRectsInTextNode(node, shot, activeRange);
    if (rects.length) out.push({ node, rects });
  }
  return out;
}

// Peel-text box in shot-local px.
export function peelTextLayoutBox(node: HTMLElement, shot: HTMLElement) {
  let left = 0;
  let top = 0;
  let cur: HTMLElement | null = node;
  while (cur && cur !== shot) {
    left += cur.offsetLeft;
    top += cur.offsetTop;
    cur = cur.offsetParent instanceof HTMLElement ? cur.offsetParent : null;
  }
  const w = Math.max(measurePaintTextWidth(node), 1);
  if (node.classList.contains("shot__index")) {
    const cs = getComputedStyle(node);
    const fontSize = parseFloat(cs.fontSize) || 11;
    const lineHeight =
      !cs.lineHeight || cs.lineHeight === "normal"
        ? fontSize * 1.2
        : cs.lineHeight.endsWith("px")
          ? parseFloat(cs.lineHeight) || fontSize
          : fontSize * parseFloat(cs.lineHeight);
    return { left, top, w, h: lineHeight };
  }
  return { left, top, w, h: Math.max(node.offsetHeight, 1) };
}

function paintSelectionLayer(ctx: CanvasRenderingContext2D, selection?: PeelTextSelection[]) {
  if (!selection?.length) return;
  ctx.fillStyle = peelSelectionColor();
  for (const { rects } of selection) {
    for (const r of rects) {
      ctx.fillRect(r.left, r.top, r.w, r.h);
    }
  }
}

function paintPeelTextLayer(ctx: CanvasRenderingContext2D, el: HTMLElement) {
  for (const node of el.querySelectorAll<HTMLElement>("[data-peel-text]")) {
    const text = node.textContent?.trim() ?? "";
    if (!text) continue;
    const box = peelTextLayoutBox(node, el);
    applyPaintFont(ctx, node);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "bottom";
    ctx.fillText(text, box.left, box.top + box.h);
  }
}

function parseObjectPosition(
  raw: string,
  boxW: number,
  boxH: number,
  drawW: number,
  drawH: number,
): { x: number; y: number } {
  const parts = raw.trim().split(/\s+/);
  const mapAxis = (token: string | undefined, box: number, draw: number, fallback: number) => {
    if (!token || token === "center") return (box - draw) * 0.5;
    if (token === "left" || token === "top") return 0;
    if (token === "right" || token === "bottom") return box - draw;
    if (token.endsWith("%")) return (box - draw) * (parseFloat(token) / 100);
    const px = parseFloat(token);
    return Number.isFinite(px) ? px : (box - draw) * fallback;
  };
  return {
    x: mapAxis(parts[0], boxW, drawW, 0.5),
    y: mapAxis(parts[1] ?? parts[0], boxH, drawH, 0.5),
  };
}

function paintPhotoCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
): boolean {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (iw < 1 || ih < 1) return false;

  const cs = getComputedStyle(img);
  const fit = cs.objectFit || "cover";
  const scale =
    fit === "contain" ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const { x, y } = parseObjectPosition(cs.objectPosition || "50% 50%", w, h, dw, dh);

  if (fit === "contain") {
    ctx.fillStyle = getComputedStyle(img.parentElement ?? img).backgroundColor || "#2a3038";
    ctx.fillRect(0, 0, w, h);
  }

  ctx.drawImage(img, x, y, dw, dh);
  return true;
}

function paintTextScrim(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createLinearGradient(0, h * 0.55, 0, h);
  g.addColorStop(0, "rgba(0, 0, 0, 0)");
  g.addColorStop(1, "rgba(0, 0, 0, 0.28)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

async function readyPhoto(img: HTMLImageElement) {
  if (img.complete && img.naturalWidth > 0) return;
  await img.decode();
}

export async function paintShotTile(
  el: HTMLElement,
  dpr = 1,
  selection?: PeelTextSelection[],
): Promise<HTMLCanvasElement> {
  const cssW = Math.max(1, Math.ceil(el.offsetWidth));
  const cssH = Math.max(1, Math.ceil(el.offsetHeight));
  const scale = Math.max(1, Math.min(dpr, 2));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cssW * scale));
  canvas.height = Math.max(1, Math.round(cssH * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("paintShotTile: 2d unavailable");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const w = cssW;
  const h = cssH;
  const photo = el.querySelector<HTMLImageElement>(".shot__photo");
  let painted = false;

  if (photo) {
    try {
      await readyPhoto(photo);
      painted = paintPhotoCover(ctx, photo, w, h);
    } catch {
      painted = false;
    }
  }

  if (!painted) {
    ctx.fillStyle = "#3d454c";
    ctx.fillRect(0, 0, w, h);
  } else {
    paintTextScrim(ctx, w, h);
  }

  paintSelectionLayer(ctx, selection);
  paintPeelTextLayer(ctx, el);

  return canvas;
}
