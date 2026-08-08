/**
 * Bake gallery `.shot` tiles to canvas for WebGL textures.
 * Gradients mirror styles.css — soft multi-stop radials (no hard blob edges).
 */

type ShotPaint = {
  linear: { angle: number; stops: [number, string][] };
  radial: {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    stops: [number, string][];
  };
};

const SHOT_PAINT: Record<string, ShotPaint> = {
  "shot--1": {
    linear: {
      angle: 160,
      stops: [
        [0, "#3d4a52"],
        [0.48, "#8fa0a8"],
        [1, "#d5dde0"],
      ],
    },
    radial: {
      cx: 0.22,
      cy: 0.18,
      rx: 0.95,
      ry: 0.75,
      stops: [
        [0, "rgba(200, 213, 220, 0.42)"],
        [0.4, "rgba(200, 213, 220, 0.16)"],
        [0.78, "rgba(200, 213, 220, 0)"],
        [1, "rgba(200, 213, 220, 0)"],
      ],
    },
  },
  "shot--2": {
    linear: {
      angle: 200,
      stops: [
        [0, "#2a3338"],
        [0.42, "#6b787f"],
        [1, "#b9c4c8"],
      ],
    },
    radial: {
      cx: 0.82,
      cy: 0.22,
      rx: 0.9,
      ry: 0.7,
      stops: [
        [0, "rgba(232, 220, 200, 0.4)"],
        [0.38, "rgba(232, 220, 200, 0.15)"],
        [0.76, "rgba(232, 220, 200, 0)"],
        [1, "rgba(232, 220, 200, 0)"],
      ],
    },
  },
  "shot--3": {
    linear: {
      angle: 145,
      stops: [
        [0, "#4a3f38"],
        [0.5, "#9a8570"],
        [1, "#e2d6c4"],
      ],
    },
    radial: {
      cx: 0.32,
      cy: 0.78,
      rx: 0.85,
      ry: 0.65,
      stops: [
        [0, "rgba(212, 196, 176, 0.4)"],
        [0.4, "rgba(212, 196, 176, 0.14)"],
        [0.78, "rgba(212, 196, 176, 0)"],
        [1, "rgba(212, 196, 176, 0)"],
      ],
    },
  },
  "shot--4": {
    linear: {
      angle: 180,
      stops: [
        [0, "#1c2228"],
        [0.45, "#4e5d68"],
        [1, "#9aabb4"],
      ],
    },
    radial: {
      cx: 0.68,
      cy: 0.32,
      rx: 0.8,
      ry: 0.62,
      stops: [
        [0, "rgba(168, 184, 196, 0.38)"],
        [0.36, "rgba(168, 184, 196, 0.14)"],
        [0.74, "rgba(168, 184, 196, 0)"],
        [1, "rgba(168, 184, 196, 0)"],
      ],
    },
  },
  "shot--5": {
    linear: {
      angle: 210,
      stops: [
        [0, "#3a4540"],
        [0.48, "#7d8f82"],
        [1, "#c5d0c4"],
      ],
    },
    radial: {
      cx: 0.18,
      cy: 0.42,
      rx: 0.92,
      ry: 0.72,
      stops: [
        [0, "rgba(220, 230, 216, 0.4)"],
        [0.4, "rgba(220, 230, 216, 0.15)"],
        [0.78, "rgba(220, 230, 216, 0)"],
        [1, "rgba(220, 230, 216, 0)"],
      ],
    },
  },
  "shot--6": {
    linear: {
      angle: 155,
      stops: [
        [0, "#252830"],
        [0.46, "#5a5f70"],
        [1, "#b0b4c0"],
      ],
    },
    radial: {
      cx: 0.58,
      cy: 0.14,
      rx: 0.88,
      ry: 0.68,
      stops: [
        [0, "rgba(196, 192, 208, 0.38)"],
        [0.38, "rgba(196, 192, 208, 0.14)"],
        [0.76, "rgba(196, 192, 208, 0)"],
        [1, "rgba(196, 192, 208, 0)"],
      ],
    },
  },
};

function linearGradient(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  angleDeg: number,
  stops: [number, string][],
): CanvasGradient {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const len = Math.hypot(w, h) / 2;
  const g = ctx.createLinearGradient(
    cx - Math.cos(rad) * len,
    cy - Math.sin(rad) * len,
    cx + Math.cos(rad) * len,
    cy + Math.sin(rad) * len,
  );
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}

/** Paint one shot; `dpr` bakes sharper textures for Retina (UV still 0…1). */
export function paintShotTile(el: HTMLElement, dpr = 1): HTMLCanvasElement {
  const cssW = Math.max(1, Math.ceil(el.offsetWidth));
  const cssH = Math.max(1, Math.ceil(el.offsetHeight));
  const scale = Math.max(1, Math.min(dpr, 2));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cssW * scale));
  canvas.height = Math.max(1, Math.round(cssH * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("paintShotTile: 2d unavailable");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  let paint: ShotPaint | null = null;
  for (const cls of el.classList) {
    if (SHOT_PAINT[cls]) {
      paint = SHOT_PAINT[cls]!;
      break;
    }
  }
  if (!paint) paint = SHOT_PAINT["shot--1"]!;

  const w = cssW;
  const h = cssH;

  ctx.fillStyle = linearGradient(ctx, w, h, paint.linear.angle, paint.linear.stops);
  ctx.fillRect(0, 0, w, h);

  const { cx, cy, rx, ry, stops } = paint.radial;
  const ex = cx * w;
  const ey = cy * h;
  const rMax = Math.max(rx * w, ry * h) * 0.5;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(ex, ey, rx * w * 0.5, ry * h * 0.5, 0, 0, Math.PI * 2);
  ctx.clip();
  const rg = ctx.createRadialGradient(ex, ey, 0, ex, ey, rMax);
  for (const [t, c] of stops) rg.addColorStop(t, c);
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  const pad = Math.round(Math.min(22, Math.max(14, h * 0.04)));
  const index = el.querySelector(".shot__index")?.textContent?.trim() ?? "";
  const cap = el.querySelector(".shot__cap")?.textContent?.trim() ?? "";

  ctx.fillStyle = "rgba(244,245,247,0.75)";
  ctx.font = "11px Fragment Mono, ui-monospace, monospace";
  if (index) ctx.fillText(index, pad, pad + 11);

  ctx.fillStyle = "#f4f5f7";
  const capSize = Math.round(Math.min(26, Math.max(16, h * 0.055)));
  ctx.font = `700 ${capSize}px Syne, system-ui, sans-serif`;
  if (cap) ctx.fillText(cap, pad, h - pad);

  return canvas;
}
