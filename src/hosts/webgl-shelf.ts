import {
  buildShotTextSelection,
  paintShotTile,
  peelTextLayoutBox,
  selectionIntersectsPeelText,
  type PeelTextLayoutResolver,
  type PeelTextSelection,
} from "../core/shot-paint";
import { addTicker, prepareTicker, removeTicker } from "../core/loop";
import type { PeelHost } from "../core/types";
import {
  packWithConstantGaps,
  PEEL_TEXT_SELECTOR,
  peelTextBoxTransform,
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

// Fragment inverts mapX (bisection) so the warp matches the field.
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

// AABB quad + fragment warp; ticker sleeps when idle.
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
  const selectionTextures = new Map<string, WebGLTexture>();
  const liveCards = new Set<HTMLElement>();
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
    bindTextureSource(tex, source);
  }

  function bindTextureSource(tex: WebGLTexture, source: HTMLCanvasElement) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  function uploadSelectionTexture(key: string, source: HTMLCanvasElement) {
    let tex = selectionTextures.get(key);
    if (!tex) {
      tex = gl.createTexture();
      if (!tex) throw new Error("WebGL: texture failed");
      selectionTextures.set(key, tex);
    }
    bindTextureSource(tex, source);
  }

  function clearSelectionTextures(keep = new Set<string>()) {
    for (const [key, tex] of selectionTextures) {
      if (keep.has(key)) continue;
      gl.deleteTexture(tex);
      selectionTextures.delete(key);
    }
  }

  function bakeSourceForKey(key: string): HTMLElement | null {
    for (const node of track.children) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.hasAttribute("data-loop-clone")) continue;
      if (shotKey(node) === key) return node;
    }
    return null;
  }

  let selectedKey: string | null = null;
  let selectedParts: PeelTextSelection[] | null = null;
  let peelTextDown: { x: number; y: number } | null = null;
  let peelTextDownShot: HTMLElement | null = null;
  let selectedShotEl: HTMLElement | null = null;
  let selectionCommitLock = 0;
  let rebakeToken = 0;
  const frozenSelectionLayout = new Map<string, Map<HTMLElement, ReturnType<typeof peelTextLayoutBox>>>();

  function shotFromSelection(sel: Selection | null): HTMLElement | null {
    if (!sel?.anchorNode) return null;
    const anchor = sel.anchorNode;
    return (
      anchor instanceof HTMLElement
        ? anchor.closest<HTMLElement>(".shot")
        : anchor.parentElement?.closest<HTMLElement>(".shot")
    ) ?? null;
  }

  function setPeelTextHitExclusive(exclusive: HTMLElement | null) {
    for (const el of liveCards) {
      for (const node of el.querySelectorAll<HTMLElement>(PEEL_TEXT_SELECTOR)) {
        node.style.pointerEvents = exclusive && el !== exclusive ? "none" : "";
      }
    }
  }

  function updatePeelTextHitExclusive() {
    const exclusive =
      peelTextDownShot ??
      selectedShotEl ??
      (selectedKey ? bakeSourceForKey(selectedKey) : null);
    setPeelTextHitExclusive(exclusive);
  }

  function captureSelectionLayout(shot: HTMLElement, key: string) {
    const map = new Map<HTMLElement, ReturnType<typeof peelTextLayoutBox>>();
    for (const node of shot.querySelectorAll<HTMLElement>(PEEL_TEXT_SELECTOR)) {
      map.set(node, peelTextLayoutBox(node, shot));
    }
    frozenSelectionLayout.set(key, map);
  }

  function layoutResolverForKey(key: string): PeelTextLayoutResolver | undefined {
    const map = frozenSelectionLayout.get(key);
    if (!map) return undefined;
    return (node, shot) => map.get(node) ?? peelTextLayoutBox(node, shot);
  }

  function clearFrozenSelectionLayout(key?: string) {
    if (key) frozenSelectionLayout.delete(key);
    else frozenSelectionLayout.clear();
  }

  function isPeelTextSelection(sel: Selection | null): boolean {
    if (!sel?.rangeCount) return false;
    if (!sel.isCollapsed) {
      return selectionIntersectsPeelText(sel.getRangeAt(0), track);
    }
    const anchor =
      sel.anchorNode instanceof HTMLElement ? sel.anchorNode : sel.anchorNode?.parentElement;
    return !!anchor?.closest("[data-peel-track] .shot.is-live [data-peel-text]");
  }

  function shotFromRange(range: Range): HTMLElement | null {
    const start =
      range.startContainer instanceof HTMLElement
        ? range.startContainer
        : range.startContainer.parentElement;
    return start?.closest<HTMLElement>("[data-peel-track] .shot") ?? null;
  }

  function commitSelectionOnShot(shot: HTMLElement, range: Range): boolean {
    if (!shot.classList.contains("is-live")) return false;
    if (peelTextDown !== null && peelTextDownShot && shot !== peelTextDownShot) return false;
    const key = shotKey(shot);
    if (key !== selectedKey) captureSelectionLayout(shot, key);
    const layout = layoutResolverForKey(key);
    const parts = buildShotTextSelection(shot, range, layout);
    if (!parts.length) return false;
    selectedKey = key;
    selectedParts = parts;
    selectedShotEl = shot;
    return true;
  }

  function restoreDomSelection(range: Range) {
    const sel = document.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function clearPeelSelection() {
    peelTextDownShot = null;
    selectedShotEl = null;
    document.getSelection()?.removeAllRanges();
    if (!selectedKey) {
      updatePeelTextHitExclusive();
      return;
    }
    clearFrozenSelectionLayout(selectedKey);
    selectedKey = null;
    selectedParts = null;
    clearSelectionTextures();
    updatePeelTextHitExclusive();
    markDirty();
  }

  function rebakeSelectedKey() {
    if (!selectedKey || !selectedParts?.length) return;
    const source = bakeSourceForKey(selectedKey);
    if (!source) return;
    const key = selectedKey;
    const layout = layoutResolverForKey(key);
    const token = ++rebakeToken;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    void paintShotTile(source, dpr, selectedParts, layout).then((canvas) => {
      if (token !== rebakeToken || selectedKey !== key) return;
      uploadSelectionTexture(key, canvas);
      markDirty();
    });
  }

  function syncSelectionState() {
    const prevKey = selectedKey;
    const sel = document.getSelection();
    const activeRange =
      sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

    const locked = performance.now() < selectionCommitLock;

    if (!locked && activeRange && selectionIntersectsPeelText(activeRange, track)) {
      const shot = shotFromRange(activeRange);
      if (shot?.classList.contains("is-live")) {
        const key = shotKey(shot);
        const sameCard = !selectedKey || key === selectedKey;
        const gesturing = peelTextDown !== null || peelTextDownShot !== null;
        if (sameCard || gesturing) {
          commitSelectionOnShot(shot, activeRange);
        }
      }
    } else if (!locked && !isPeelTextSelection(sel)) {
      if (peelTextDown !== null || peelTextDownShot) {
        /* mid-gesture — keep DOM + canvas selection */
      } else if (!(selectedKey && selectedParts?.length)) {
        if (selectedKey) clearFrozenSelectionLayout(selectedKey);
        selectedKey = null;
        selectedParts = null;
        selectedShotEl = null;
      }
    }

    const keep = selectedKey ? new Set([selectedKey]) : new Set<string>();
    clearSelectionTextures(keep);

    if (selectedKey && selectedParts) {
      rebakeSelectedKey();
    } else if (prevKey) {
      markDirty();
    }
  }

  function onSelectionChange() {
    if (peelTextDown !== null || peelTextDownShot) {
      if (peelTextDown !== null) {
        const sel = document.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const allowed = peelTextDownShot;
          if (!allowed || !selectionIntersectsPeelText(range, allowed)) return;
          if (commitSelectionOnShot(allowed, range)) {
            const keep = selectedKey ? new Set([selectedKey]) : new Set<string>();
            clearSelectionTextures(keep);
            rebakeSelectedKey();
          }
        }
        markDirty();
      }
      return;
    }
    syncSelectionState();
    markDirty();
  }

  function bakeTextures() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const seen = new Set<string>();
    const jobs: Promise<void>[] = [];

    for (const node of track.children) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.hasAttribute("data-loop-clone")) continue;
      const key = shotKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(
        paintShotTile(node, dpr).then((source) => {
          uploadTexture(key, source);
        }),
      );
    }

    void Promise.all(jobs).then(() => markDirty());
  }

  function bindPhotoRebake() {
    for (const img of track.querySelectorAll<HTMLImageElement>(".shot__photo")) {
      if (img.dataset.peelBound === "1") continue;
      img.dataset.peelBound = "1";
      img.addEventListener("load", () => bakeTextures(), { once: false });
    }
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

  function clearPeelText(el: HTMLElement) {
    for (const node of el.querySelectorAll<HTMLElement>(PEEL_TEXT_SELECTOR)) {
      node.style.transform = "";
      node.style.transformOrigin = "";
      node.style.width = "";
    }
  }

  function clearLiveCards() {
    for (const el of liveCards) {
      el.classList.remove("is-live");
      clearPeelText(el);
      if (el.tabIndex === 0) el.removeAttribute("tabindex");
    }
    setPeelTextHitExclusive(null);
    liveCards.clear();
  }

  /** One peel-text host per shot key — loop clones overlap and steal selection. */
  function pickLivePacked(packed: PackedCard[], mid: number): PackedCard[] {
    const byKey = new Map<string, PackedCard[]>();
    for (const item of packed) {
      const key = shotKey(item.card.el);
      const list = byKey.get(key) ?? [];
      list.push(item);
      byKey.set(key, list);
    }

    const out: PackedCard[] = [];
    for (const items of byKey.values()) {
      const nonClones = items.filter((i) => !i.card.el.hasAttribute("data-loop-clone"));
      const pool = nonClones.length ? nonClones : items;
      let best = pool[0]!;
      let bestDist = Infinity;
      for (const item of pool) {
        const cx = (visualLeft(item) + visualRight(item)) / 2;
        const d = Math.abs(cx - mid);
        if (d < bestDist) {
          bestDist = d;
          best = item;
        }
      }
      out.push(best);
    }
    return out;
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

  function shouldFreezePeelDom(el: HTMLElement): boolean {
    if (peelTextDownShot === el) return true;
    if (selectedKey !== null && shotKey(el) === selectedKey) return true;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      return shotFromSelection(sel) === el;
    }
    if (isPeelTextSelection(sel) && shotFromSelection(sel) === el) return true;
    return false;
  }

  function syncLiveCards(packed: PackedCard[]) {
    const mid = viewCssW / 2;
    const liveItems = pickLivePacked(packed, mid);
    const liveItemEls = new Set(liveItems.map((item) => item.card.el));

    for (const item of packed) {
      const el = item.card.el;
      if (liveItemEls.has(el)) continue;
      if (shouldFreezePeelDom(el)) {
        liveItems.push(item);
        liveItemEls.add(el);
      }
    }

    const nextLive = new Set<HTMLElement>();

    for (const item of liveItems) {
      const el = item.card.el;
      const textNodes = el.querySelectorAll<HTMLElement>(PEEL_TEXT_SELECTOR);
      if (!textNodes.length) continue;

      if (shouldFreezePeelDom(el)) {
        el.classList.add("is-live");
        nextLive.add(el);
        continue;
      }

      let synced = false;
      for (const node of textNodes) {
        const box = peelTextLayoutBox(node, el);
        if (box.w < 2 && box.h < 2) continue;
        if (!node.classList.contains("shot__index")) {
          node.style.width = `${box.w}px`;
        }
        node.style.transformOrigin = "0 0";
        node.style.transform = peelTextBoxTransform(item, box, viewCssW, field);
        synced = true;
      }
      if (!synced) continue;

      el.classList.add("is-live");
      nextLive.add(el);
    }

    for (const el of liveCards) {
      if (nextLive.has(el)) continue;
      el.classList.remove("is-live");
      clearPeelText(el);
      if (el.tabIndex === 0) el.removeAttribute("tabindex");
    }

    for (const node of track.children) {
      if (!(node instanceof HTMLElement)) continue;
      if (nextLive.has(node)) continue;
      if (!node.classList.contains("is-live")) continue;
      node.classList.remove("is-live");
      clearPeelText(node);
    }

    liveCards.clear();
    for (const el of nextLive) liveCards.add(el);

    if (centerEl && liveCards.has(centerEl)) centerEl.tabIndex = 0;
    updatePeelTextHitExclusive();
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
    const key = shotKey(item.card.el);
    const tex =
      selectedKey === key ? (selectionTextures.get(key) ?? textures.get(key)) : textures.get(key);
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

    syncCenterCard(packed, mid);
    syncLiveCards(packed);

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

  function onGalleryClick(e: MouseEvent) {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest("[data-peel-track] [data-peel-text]")) return;
    clearPeelSelection();
  }

  function onTrackPointerDown(e: PointerEvent) {
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest("[data-peel-track] [data-peel-text]")) return;
    peelTextDown = { x: e.clientX, y: e.clientY };
    peelTextDownShot = e.target.closest<HTMLElement>(".shot");
    if (peelTextDownShot) {
      captureSelectionLayout(peelTextDownShot, shotKey(peelTextDownShot));
      setPeelTextHitExclusive(peelTextDownShot);
    }
  }

  function onTrackPointerUp(e: PointerEvent) {
    const down = peelTextDown;
    const downShot = peelTextDownShot;
    const tap = down
      ? (e.clientX - down.x) ** 2 + (e.clientY - down.y) ** 2 <= 16
      : false;
    const sel = document.getSelection();
    const rangeSnapshot =
      !tap && sel && !sel.isCollapsed && sel.rangeCount > 0
        ? sel.getRangeAt(0).cloneRange()
        : null;

    requestAnimationFrame(() => {
      if (rangeSnapshot && downShot?.classList.contains("is-live")) {
        if (commitSelectionOnShot(downShot, rangeSnapshot)) {
          const keep = selectedKey ? new Set([selectedKey]) : new Set<string>();
          clearSelectionTextures(keep);
          rebakeSelectedKey();
        }
        restoreDomSelection(rangeSnapshot);
        selectionCommitLock = performance.now() + 120;
      } else {
        syncSelectionState();
      }

      peelTextDown = null;
      peelTextDownShot = null;
      updatePeelTextHitExclusive();
      markDirty();

      if (!tap) return;
      if (!(e.target instanceof Element)) return;
      if (!e.target.closest("[data-peel-track] [data-peel-text]")) return;
      const endSel = document.getSelection();
      if (endSel?.isCollapsed) clearPeelSelection();
    });
  }

  function onRootResize() {
    resize();
  }

  prepareTicker();
  resize();
  bindPhotoRebake();
  mount.classList.add("is-peeled");
  ensureTicker();

  const ro = new ResizeObserver(onRootResize);
  ro.observe(mount);
  ro.observe(track);

  scroller.addEventListener("scroll", onScroll, { passive: true });
  scroller.addEventListener("click", onGalleryClick, true);
  track.addEventListener("pointerdown", onTrackPointerDown, true);
  track.addEventListener("pointerup", onTrackPointerUp, true);
  track.addEventListener("pointercancel", onTrackPointerUp, true);
  document.addEventListener("selectionchange", onSelectionChange);
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
      scroller.removeEventListener("click", onGalleryClick, true);
      track.removeEventListener("pointerdown", onTrackPointerDown, true);
      track.removeEventListener("pointerup", onTrackPointerUp, true);
      track.removeEventListener("pointercancel", onTrackPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      selectedKey = null;
      selectedParts = null;
      selectedShotEl = null;
      clearFrozenSelectionLayout();
      clearSelectionTextures();
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
