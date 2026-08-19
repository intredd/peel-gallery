// Shelf field s(x), gap-preserving pack, peel text matrix. `field` is live-tuned.

export type CardRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  el: HTMLElement;
};

export type ShelfHit = {
  el: HTMLElement;
  left: number;
  right: number;
  cx: number;
};

export type ShelfHitModel = {
  viewW: number;
  hits: ShelfHit[];
};

// Tuner knobs — innerPct/shoulderPct are % of half viewport width.
export type ShelfFieldParams = {
  innerPct: number;
  shoulderPct: number;
  vx1: number;
  vy1: number;
  vx2: number;
  vy2: number;
  maxScale: number;
  minScale: number;
};

export function shelfRadiiPx(field: ShelfFieldParams, viewW: number) {
  const half = Math.max(1, viewW * 0.5);
  const inner = Math.max(0, (field.innerPct / 100) * half);
  const shoulder = Math.max(1, (field.shoulderPct / 100) * half);
  return { inner, outer: inner + shoulder, half };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function cubicBernstein(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function cubicBernsteinDeriv(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return 3 * u * u * (p1 - p0) + 6 * u * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

export function rampControls(field: ShelfFieldParams) {
  return {
    p1x: field.vx1,
    p1y: 1 + field.vy1,
    p2x: 1 + field.vx2,
    p2y: field.vy2,
  };
}

function smoothstep01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

// 0 = soft ramp, 1 = near-step — smooths harsh tuner curves.
export function rampHarshness(field: ShelfFieldParams): number {
  const { p1x, p1y, p2x, p2y } = rampControls(field);
  const vert = (dy: number, dx: number) => Math.abs(dy) / Math.max(Math.abs(dx), 0.08);
  const peak = Math.max(vert(p1y - 1, p1x), vert(p2y - p1y, p2x - p1x), vert(-p2y, 1 - p2x));
  return clamp01((peak - 1.15) / 5.5);
}

export function bezierRampAt(xNorm: number, field: ShelfFieldParams): number {
  const xRaw = clamp01(xNorm);
  const harsh = rampHarshness(field);
  const x = xRaw + (smoothstep01(xRaw) - xRaw) * harsh * 0.9;

  const { p1x, p1y, p2x, p2y } = rampControls(field);

  let t = x;
  for (let i = 0; i < 8; i++) {
    const xEst = cubicBernstein(t, 0, p1x, p2x, 1);
    const dx = cubicBernsteinDeriv(t, 0, p1x, p2x, 1);
    if (Math.abs(dx) < 1e-6) break;
    t -= (xEst - x) / dx;
    t = clamp01(t);
  }

  const y = cubicBernstein(t, 1, p1y, p2y, 0);
  const ySoft = 1 - smoothstep01(xRaw);
  return y + (ySoft - y) * harsh * 0.4;
}

export function threeShelf(
  xFromCenter: number,
  field: ShelfFieldParams,
  viewW: number,
): number {
  const { inner, outer } = shelfRadiiPx(field, viewW);
  const ax = Math.abs(xFromCenter);
  if (ax <= inner) return 1;
  if (ax >= outer) return 0;
  const span = outer - inner;
  if (span <= 1e-6) return 0;
  return bezierRampAt((ax - inner) / span, field);
}

export function scaleFromU(u: number, field: ShelfFieldParams): number {
  const center = Math.max(0.5, Math.min(1, field.maxScale));
  const edge = Math.max(0.5, Math.min(1, field.minScale));
  return edge + clamp01(u) * (center - edge);
}

export function scaleAtX(x: number, viewW: number, field: ShelfFieldParams): number {
  const u = threeShelf(x - viewW / 2, field, viewW);
  return scaleFromU(u, field);
}

export type PackedCard = {
  card: CardRect;
  cx: number;
  cy: number;
  sL: number;
  sR: number;
  tx: number;
};

export function visualLeft(item: PackedCard): number {
  return item.cx + item.tx - (item.card.w / 2) * item.sL;
}

export function visualRight(item: PackedCard): number {
  return item.cx + item.tx + (item.card.w / 2) * item.sR;
}

export type TextBox = {
  left: number;
  top: number;
  w: number;
  h: number;
};

export type CaptionBox = TextBox;

export const PEEL_TEXT_SELECTOR = "[data-peel-text]";

// DOM text box → same baseline warp as the fragment shader.
export function peelTextBoxTransform(
  item: PackedCard,
  box: TextBox,
  viewW: number,
  field: ShelfFieldParams,
): string {
  if (box.w < 1 || box.h < 1) return "";

  const { card, cx, cy, tx } = item;
  const midCx = cx + tx;
  const warp = (localX: number, localY: number) => {
    const s = scaleAtX(card.x + localX, viewW, field);
    return {
      x: midCx + (localX - card.w * 0.5) * s,
      y: cy + s * (localY - card.h * 0.5),
    };
  };

  const x0 = box.left;
  const x1 = box.left + box.w;
  const y0 = box.top;
  const y1 = box.top + box.h;
  const tl = warp(x0, y0);
  const bl = warp(x0, y1);
  const br = warp(x1, y1);

  const e = tl.x - (card.x + x0);
  const f = tl.y - (card.y + y0);
  const a = (br.x - bl.x) / box.w;
  const b = (br.y - bl.y) / box.w;
  const c = (bl.x - tl.x) / box.h;
  const d = (bl.y - tl.y) / box.h;

  return `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`;
}

export function packWithConstantGaps(
  cards: CardRect[],
  mid: number,
  sAt: (x: number) => number,
): PackedCard[] {
  const items: PackedCard[] = cards
    .map((card) => {
      const cx = card.x + card.w / 2;
      const cy = card.y + card.h / 2;
      return {
        card,
        cx,
        cy,
        sL: sAt(card.x),
        sR: sAt(card.x + card.w),
        tx: 0,
      };
    })
    .sort((a, b) => a.cx - b.cx);

  if (items.length === 0) return items;

  // Card under viewport mid anchors the pack; else grow from the gap.
  let anchor = items.findIndex(
    (it) => it.card.x < mid && it.card.x + it.card.w > mid,
  );

  if (anchor >= 0) {
    const a = items[anchor]!;
    const sMid = sAt(mid);
    a.tx = (mid - a.cx) * (1 - sMid);

    for (let i = anchor; i < items.length - 1; i++) {
      const left = items[i]!;
      const right = items[i + 1]!;
      const layoutGap = right.card.x - (left.card.x + left.card.w);
      right.tx = visualRight(left) + layoutGap - right.cx + (right.card.w / 2) * right.sL;
    }
    for (let i = anchor; i > 0; i--) {
      const left = items[i - 1]!;
      const right = items[i]!;
      const layoutGap = right.card.x - (left.card.x + left.card.w);
      left.tx = visualLeft(right) - layoutGap - left.cx - (left.card.w / 2) * left.sR;
    }
    return items;
  }

  const right = items.filter((it) => it.cx >= mid);
  const left = items.filter((it) => it.cx < mid);

  let prevVisualRight = mid;
  let prevLayoutRight = mid;
  for (const item of right) {
    const layoutGap = item.card.x - prevLayoutRight;
    item.tx = prevVisualRight + layoutGap - item.cx + (item.card.w / 2) * item.sL;
    prevVisualRight = visualRight(item);
    prevLayoutRight = item.card.x + item.card.w;
  }

  let prevVisualLeft = mid;
  let prevLayoutLeft = mid;
  for (let i = left.length - 1; i >= 0; i--) {
    const item = left[i]!;
    const layoutGap = prevLayoutLeft - (item.card.x + item.card.w);
    item.tx = prevVisualLeft - layoutGap - item.cx - (item.card.w / 2) * item.sR;
    prevVisualLeft = visualLeft(item);
    prevLayoutLeft = item.card.x;
  }

  return items;
}
