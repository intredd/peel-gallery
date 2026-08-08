import { paintShotTile } from "../core/shot-paint";
import { addTicker, prepareTicker, removeTicker } from "../core/loop";
import type { PeelHost } from "../core/types";
import {
  packWithConstantGaps,
  rampControls,
  rampHarshness,
  scaleAtX,
  shelfRadiiPx,
  visualLeft,
  visualRight,
  type CardRect,
  type PackedCard,
  type ShelfFieldParams,
  type ShelfHitModel,
} from "../effects/shelf-envelope";

export type WebGLShelfOptions = {
  mount: HTMLElement;
  scroller: HTMLElement;
  track: HTMLElement;
  field: ShelfFieldParams;
  getCards: () => CardRect[];
  hitModel?: ShelfHitModel;
};

/**
 * Vertex: viewport CSS px → clip.
 * Fragment: inverse peel mapX(local) via bisection → sample texture (pixel-accurate curve).
 */
const VS = `
attribute vec2 a_pos;
uniform vec2 u_view;
varying vec2 v_pos;
void main() {
  v_pos = a_pos;
  vec2 clip = (a_pos / u_view) * 2.0 - 1.0;
  clip.y *= -1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_viewW;
uniform float u_inner;
uniform float u_outer;
uniform float u_p1x;
uniform float u_p1y;
uniform float u_p2x;
uniform float u_p2y;
uniform float u_harsh;
uniform float u_centerS;
uniform float u_edgeS;
uniform float u_cardX;
uniform float u_cardW;
uniform float u_cardH;
uniform float u_midCx;
uniform float u_cy;
varying vec2 v_pos;

float clamp01(float v) { return clamp(v, 0.0, 1.0); }

float smoothstep01(float x) {
  float t = clamp01(x);
  return t * t * (3.0 - 2.0 * t);
}

float cubic(float t, float p0, float p1, float p2, float p3) {
  float u = 1.0 - t;
  return u * u * u * p0 + 3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t * p3;
}

float cubicDeriv(float t, float p0, float p1, float p2, float p3) {
  float u = 1.0 - t;
  return 3.0 * u * u * (p1 - p0) + 6.0 * u * t * (p2 - p1) + 3.0 * t * t * (p3 - p2);
}

float bezierRampAt(float xNorm) {
  float xRaw = clamp01(xNorm);
  float x = xRaw + (smoothstep01(xRaw) - xRaw) * u_harsh * 0.9;
  float t = x;
  for (int i = 0; i < 8; i++) {
    float xEst = cubic(t, 0.0, u_p1x, u_p2x, 1.0);
    float dx = cubicDeriv(t, 0.0, u_p1x, u_p2x, 1.0);
    if (abs(dx) < 1e-6) break;
    t = clamp01(t - (xEst - x) / dx);
  }
  float y = cubic(t, 1.0, u_p1y, u_p2y, 0.0);
  float ySoft = 1.0 - smoothstep01(xRaw);
  return y + (ySoft - y) * u_harsh * 0.4;
}

float threeShelf(float xFromCenter) {
  float ax = abs(xFromCenter);
  if (ax <= u_inner) return 1.0;
  if (ax >= u_outer) return 0.0;
  float span = u_outer - u_inner;
  if (span <= 1e-6) return 0.0;
  return bezierRampAt((ax - u_inner) / span);
}

float scaleAtLayoutX(float x) {
  float u = threeShelf(x - u_viewW * 0.5);
  return u_edgeS + clamp01(u) * (u_centerS - u_edgeS);
}

float mapX(float local) {
  float s = scaleAtLayoutX(u_cardX + local);
  return u_midCx + (local - u_cardW * 0.5) * s;
}

void main() {
  float lo = 0.0;
  float hi = u_cardW;
  for (int i = 0; i < 18; i++) {
    float mid = 0.5 * (lo + hi);
    if (mapX(mid) < v_pos.x) lo = mid;
    else hi = mid;
  }
  float local = 0.5 * (lo + hi);
  float s = scaleAtLayoutX(u_cardX + local);
  float h = u_cardH * s;
  float y0 = u_cy - h * 0.5;
  float y1 = u_cy + h * 0.5;
  if (v_pos.y < y0 || v_pos.y > y1) discard;

  float u = local / u_cardW;
  float v = (v_pos.y - y0) / max(h, 1e-4);
  if (u < 0.0 || u > 1.0) discard;
  gl_FragColor = texture2D(u_tex, vec2(u, clamp01(v)));
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("WebGL: createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || "compile error";
    gl.deleteShader(sh);
    throw new Error(`WebGL shader: ${log}`);
  }
  return sh;
}

function linkProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error("WebGL: createProgram failed");
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || "link error";
    gl.deleteProgram(prog);
    throw new Error(`WebGL program: ${log}`);
  }
  return prog;
}

function shotKey(el: HTMLElement): string {
  for (const cls of el.classList) {
    if (cls.startsWith("shot--")) return cls;
  }
  return el.className || "shot";
}

function loc(gl: WebGLRenderingContext, prog: WebGLProgram, name: string) {
  return gl.getUniformLocation(prog, name);
}

/**
 * WebGL peel host — AABB quad + fragment inverse warp (same field + packing).
 * Ticker sleeps while idle.
 */
export function createWebGLShelf(options: WebGLShelfOptions): PeelHost {
  const { mount, scroller, track, field, getCards, hitModel } = options;

  const canvas = document.createElement("canvas");
  canvas.className = "peel-canvas";
  canvas.style.pointerEvents = "none";
  mount.appendChild(canvas);

  const glCtx = canvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
  });
  if (!glCtx) throw new Error("WebGL unavailable");
  const gl = glCtx;

  const prog = linkProgram(gl, VS, FS);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  const uView = loc(gl, prog, "u_view");
  const uTex = loc(gl, prog, "u_tex");
  const uViewW = loc(gl, prog, "u_viewW");
  const uInner = loc(gl, prog, "u_inner");
  const uOuter = loc(gl, prog, "u_outer");
  const uP1x = loc(gl, prog, "u_p1x");
  const uP1y = loc(gl, prog, "u_p1y");
  const uP2x = loc(gl, prog, "u_p2x");
  const uP2y = loc(gl, prog, "u_p2y");
  const uHarsh = loc(gl, prog, "u_harsh");
  const uCenterS = loc(gl, prog, "u_centerS");
  const uEdgeS = loc(gl, prog, "u_edgeS");
  const uCardX = loc(gl, prog, "u_cardX");
  const uCardW = loc(gl, prog, "u_cardW");
  const uCardH = loc(gl, prog, "u_cardH");
  const uMidCx = loc(gl, prog, "u_midCx");
  const uCy = loc(gl, prog, "u_cy");

  const vbo = gl.createBuffer();
  if (!vbo) throw new Error("WebGL: buffer failed");
  const quad = new Float32Array(8);

  const textures = new Map<string, WebGLTexture>();
  const liveCards = new Set<HTMLElement>();
  /** Max |sL−sR| to treat a card as flat enough for live DOM. */
  const FLAT_EPS = 0.028;
  let lastPacked: PackedCard[] = [];
  let centerEl: HTMLElement | null = null;
  let viewCssW = 1;
  let viewCssH = 1;
  let dirty = true;
  let ticking = false;
  let lastScrollLeft = Number.NaN;
  let lastScrollTop = Number.NaN;

  function ensureTicker() {
    if (ticking) return;
    ticking = true;
    addTicker(onTick);
  }

  function markDirty() {
    dirty = true;
    ensureTicker();
  }

  function uploadTexture(key: string, source: HTMLCanvasElement) {
    let tex = textures.get(key);
    if (!tex) {
      tex = gl.createTexture();
      if (!tex) throw new Error("WebGL: texture failed");
      textures.set(key, tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  function bakeTextures() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const seen = new Set<string>();
    for (const node of track.children) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.hasAttribute("data-loop-clone")) continue;
      const key = shotKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
      uploadTexture(key, paintShotTile(node, dpr));
    }
    markDirty();
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewCssW = Math.max(1, mount.clientWidth);
    viewCssH = Math.max(1, mount.clientHeight);
    canvas.width = Math.floor(viewCssW * dpr);
    canvas.height = Math.floor(viewCssH * dpr);
    canvas.style.width = `${viewCssW}px`;
    canvas.style.height = `${viewCssH}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
    bakeTextures();
  }

  function clearLiveCards() {
    for (const el of liveCards) {
      el.classList.remove("is-live");
      el.style.transform = "";
      el.style.transformOrigin = "";
      if (el.tabIndex === 0) el.removeAttribute("tabindex");
    }
    liveCards.clear();
  }

  function clearCenterMark() {
    if (centerEl) {
      centerEl.classList.remove("is-center");
      centerEl = null;
    }
  }

  function syncCenterCard(packed: PackedCard[], mid: number) {
    clearCenterMark();
    let best: PackedCard | null = null;
    let bestDist = Infinity;
    for (const item of packed) {
      const cx = (visualLeft(item) + visualRight(item)) / 2;
      const d = Math.abs(cx - mid);
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }
    if (!best) return;
    centerEl = best.card.el;
    centerEl.classList.add("is-center");
  }

  function syncLiveCards(packed: PackedCard[], mid: number) {
    clearLiveCards();
    // Only the centered card when it's flat — other live nodes steal pointer / break drag.
    let best: PackedCard | null = null;
    let bestDist = Infinity;
    for (const item of packed) {
      const cx = (visualLeft(item) + visualRight(item)) / 2;
      const d = Math.abs(cx - mid);
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }
    if (!best || Math.abs(best.sL - best.sR) > FLAT_EPS) return;
    const el = best.card.el;
    const s = (best.sL + best.sR) * 0.5;
    el.classList.add("is-live");
    el.style.transformOrigin = "center center";
    el.style.transform = `translate3d(${best.tx}px, 0, 0) scale(${s})`;
    el.tabIndex = 0;
    liveCards.add(el);
  }

  function cardContains(item: PackedCard, x: number, y: number): boolean {
    const left = visualLeft(item);
    const right = visualRight(item);
    const s = Math.max(item.sL, item.sR);
    const halfH = item.card.h * s * 0.5;
    const y0 = item.cy - halfH;
    const y1 = item.cy + halfH;
    return x >= left && x <= right && y >= y0 && y <= y1;
  }

  function onCursorMove(e: PointerEvent) {
    if (scroller.classList.contains("is-dragging")) return;

    const rect = mount.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let hit: PackedCard | null = null;
    let hitDist = Infinity;
    const mid = viewCssW / 2;
    for (const item of lastPacked) {
      if (!cardContains(item, x, y)) continue;
      const cx = (visualLeft(item) + visualRight(item)) / 2;
      const d = Math.abs(cx - mid);
      if (d < hitDist) {
        hitDist = d;
        hit = item;
      }
    }

    if (hit && hit.card.el === centerEl) {
      scroller.style.cursor = "default";
    } else {
      scroller.style.cursor = "grab";
    }
  }

  function setFieldUniforms(viewW: number) {
    const { inner, outer } = shelfRadiiPx(field, viewW);
    const { p1x, p1y, p2x, p2y } = rampControls(field);
    const centerS = Math.max(0.5, Math.min(1, field.maxScale));
    const edgeS = Math.max(0.5, Math.min(1, field.minScale));
    gl.uniform1f(uViewW, viewW);
    gl.uniform1f(uInner, inner);
    gl.uniform1f(uOuter, outer);
    gl.uniform1f(uP1x, p1x);
    gl.uniform1f(uP1y, p1y);
    gl.uniform1f(uP2x, p2x);
    gl.uniform1f(uP2y, p2y);
    gl.uniform1f(uHarsh, rampHarshness(field));
    gl.uniform1f(uCenterS, centerS);
    gl.uniform1f(uEdgeS, edgeS);
  }

  function drawCard(item: PackedCard) {
    if (liveCards.has(item.card.el)) return;
    const tex = textures.get(shotKey(item.card.el));
    if (!tex) return;

    const { card, cx, cy, tx, sL, sR } = item;
    const midCx = cx + tx;
    const left = visualLeft(item) - 1.5;
    const right = visualRight(item) + 1.5;
    const maxS = Math.max(
      Math.max(0.5, Math.min(1, field.maxScale)),
      Math.max(0.5, Math.min(1, field.minScale)),
      sL,
      sR,
    );
    const halfH = card.h * maxS * 0.5 + 2;
    const y0 = cy - halfH;
    const y1 = cy + halfH;

    quad[0] = left;
    quad[1] = y0;
    quad[2] = right;
    quad[3] = y0;
    quad[4] = left;
    quad[5] = y1;
    quad[6] = right;
    quad[7] = y1;

    gl.uniform1f(uCardX, card.x);
    gl.uniform1f(uCardW, card.w);
    gl.uniform1f(uCardH, card.h);
    gl.uniform1f(uMidCx, midCx);
    gl.uniform1f(uCy, cy);

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function onTick() {
    const scrollLeft = Math.round(scroller.scrollLeft);
    const scrollTop = Math.round(scroller.scrollTop);

    if (!dirty && scrollLeft === lastScrollLeft && scrollTop === lastScrollTop) {
      removeTicker(onTick);
      ticking = false;
      return;
    }

    dirty = false;
    lastScrollLeft = scrollLeft;
    lastScrollTop = scrollTop;

    const viewW = viewCssW;
    const mid = viewW / 2;
    const sAt = (x: number) => scaleAtX(x, viewW, field);

    const cards = getCards().filter((c) => c.w >= 48 && c.h >= 48);
    const packed = packWithConstantGaps(cards, mid, sAt);

    if (hitModel) {
      hitModel.viewW = viewW;
      hitModel.hits = packed
        .filter((item) => item.card.el)
        .map((item) => {
          const left = visualLeft(item);
          const right = visualRight(item);
          return {
            el: item.card.el,
            left,
            right,
            cx: (left + right) / 2,
          };
        });
    }

    syncLiveCards(packed, mid);
    syncCenterCard(packed, mid);
    lastPacked = packed;

    packed.sort((a, b) => {
      const ca = Math.abs(a.cx + a.tx - mid);
      const cb = Math.abs(b.cx + b.tx - mid);
      return cb - ca;
    });

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(prog);
    gl.uniform2f(uView, viewW, viewCssH);
    gl.uniform1i(uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    setFieldUniforms(viewW);

    const pad = viewW * 0.15;
    for (const item of packed) {
      const left = visualLeft(item);
      const right = visualRight(item);
      if (right < -pad || left > viewW + pad) continue;
      drawCard(item);
    }
  }

  function onScroll() {
    markDirty();
  }

  function onRootResize() {
    resize();
  }

  prepareTicker();
  resize();
  mount.classList.add("is-peeled");
  ensureTicker();

  const ro = new ResizeObserver(onRootResize);
  ro.observe(mount);
  ro.observe(track);

  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.addEventListener("pointermove", onCursorMove, { passive: true });
  document.fonts.ready.then(() => {
    bakeTextures();
  });

  return {
    invalidate: () => {
      bakeTextures();
    },
    requestFrame: markDirty,
    destroy: () => {
      if (ticking) {
        removeTicker(onTick);
        ticking = false;
      }
      ro.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("pointermove", onCursorMove);
      scroller.style.cursor = "";
      mount.classList.remove("is-peeled");
      clearLiveCards();
      clearCenterMark();
      for (const tex of textures.values()) gl.deleteTexture(tex);
      textures.clear();
      gl.deleteBuffer(vbo);
      gl.deleteProgram(prog);
      canvas.remove();
    },
  };
}
