import "./styles.css";
import {
  type ShelfFieldParams,
  type ShelfHitModel,
} from "./effects/shelf-envelope";
import { bindGalleryScroll } from "./gallery/scroll";
import { createWebGLShelf } from "./hosts/webgl-shelf";
import { loadShelfField, saveShelfField } from "./shelf-persist";
import { mountShelfTuner, type ShelfTuner } from "./ui/shelf-tuner";

const STAGE_MODE = new URLSearchParams(location.search).has("stage");

const shell = document.querySelector<HTMLElement>("[data-peel-root]");
const scroller = document.querySelector<HTMLElement>("[data-gallery-scroller]");
const track = document.querySelector<HTMLElement>("[data-peel-track]");

if (!shell || !scroller || !track) {
  throw new Error("Missing gallery shell / scroller / track");
}

const mount = shell;
const gallery = scroller;
const strip = track;

const hitModel: ShelfHitModel = { viewW: 0, hits: [] };

const scroll = bindGalleryScroll(gallery, strip, {
  resolveSlideAt: (viewX) => {
    const hits = hitModel.hits;
    if (!hits.length) return null;
    let best = hits[0]!;
    let bestDist = Infinity;
    for (const hit of hits) {
      if (viewX >= hit.left && viewX <= hit.right) {
        return { el: hit.el, cx: hit.cx };
      }
      const d = Math.abs(hit.cx - viewX);
      if (d < bestDist) {
        bestDist = d;
        best = hit;
      }
    }
    return { el: best.el, cx: best.cx };
  },
});

const desktopShelfField: ShelfFieldParams = {
  innerPct: 25,
  shoulderPct: 45,
  vx1: 0.55,
  vy1: 0,
  vx2: -0.70,
  vy2: 0,
  maxScale: 1,
  minScale: 0.65,
};

const MOBILE_MQ = window.matchMedia("(max-width: 720px)");

const mobileShelfField: ShelfFieldParams = {
  innerPct: 58,
  shoulderPct: 72,
  vx1: 0.62,
  vy1: 0,
  vx2: -0.55,
  vy2: 0,
  maxScale: 1,
  minScale: 0.9,
};

const shelfField: ShelfFieldParams = { ...desktopShelfField };

if (STAGE_MODE) {
  document.documentElement.classList.add("is-stage");
  const savedField = loadShelfField();
  if (savedField) Object.assign(shelfField, savedField);
}

function applyShelfPreset(mobile: boolean) {
  if (STAGE_MODE) return;
  Object.assign(shelfField, mobile ? mobileShelfField : desktopShelfField);
}

let tuner: ShelfTuner | null = null;

function cardsInViewport() {
  const scrollLeft = Math.round(gallery.scrollLeft);
  const scrollTop = Math.round(gallery.scrollTop);
  const viewW = gallery.clientWidth;
  const viewH = gallery.clientHeight;
  const cardW = strip.querySelector<HTMLElement>(".shot")?.offsetWidth || 280;
  const overscan = Math.round(cardW * 1.25);
  const cards = [];

  for (const node of strip.children) {
    if (!(node instanceof HTMLElement)) continue;
    const x = node.offsetLeft - scrollLeft;
    const y = node.offsetTop - scrollTop;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    if (x + w < -overscan - w || x > viewW + overscan + w) continue;
    if (y + h < 0 || y > viewH) continue;
    cards.push({ x, y, w, h, el: node });
  }
  return cards;
}

const peel = createWebGLShelf({
  mount,
  scroller: gallery,
  track: strip,
  field: shelfField,
  getCards: cardsInViewport,
  hitModel,
});

function syncTuner() {
  if (STAGE_MODE || MOBILE_MQ.matches) {
    tuner?.destroy();
    tuner = null;
    return;
  }
  if (!tuner) {
    tuner = mountShelfTuner(shelfField, {
      onChange: () => {
        saveShelfField(shelfField);
        peel.requestFrame();
      },
    });
  }
}

function syncMobileLayout() {
  applyShelfPreset(MOBILE_MQ.matches);
  syncTuner();
  peel.requestFrame();
}

syncMobileLayout();
MOBILE_MQ.addEventListener("change", syncMobileLayout);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    peel.destroy();
    scroll.destroy();
    tuner?.destroy();
  });
}
