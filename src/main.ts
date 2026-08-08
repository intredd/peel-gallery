import "./styles.css";
import {
  type ShelfFieldParams,
  type ShelfHitModel,
} from "./effects/shelf-envelope";
import { bindGalleryScroll } from "./gallery/scroll";
import { createWebGLShelf } from "./hosts/webgl-shelf";
import { mountShelfTuner } from "./ui/shelf-tuner";

/** Peel Gallery — infinite strip + WebGL shelf peel. */

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

const shelfField: ShelfFieldParams = {
  innerPct: 25,
  shoulderPct: 45,
  vx1: 0.55,
  vy1: 0,
  vx2: -0.70,
  vy2: 0,
  maxScale: 1,
  minScale: 0.65,
};

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

const tuner = mountShelfTuner(shelfField, {
  onChange: () => peel.requestFrame(),
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    peel.destroy();
    scroll.destroy();
    tuner.destroy();
  });
}
