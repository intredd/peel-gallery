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
  return { left, top, w, h: Math.max(node.offsetHeight, 1) };
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

export async function paintShotTile(el: HTMLElement, dpr = 1): Promise<HTMLCanvasElement> {
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

  paintPeelTextLayer(ctx, el);

  return canvas;
}
