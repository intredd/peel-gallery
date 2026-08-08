import gsap from "gsap";

export type GalleryScroll = {
  destroy: () => void;
  /** Width of one logical slide set (loop normalize / progress). */
  getSetWidth: () => number;
};

export type GalleryScrollOptions = {
  /**
   * Hit-test in viewport space (0 = left of scroller).
   * Return the slide under the peel-warped card, or null to fall back to layout.
   */
  resolveSlideAt?: (viewX: number) => { el: HTMLElement; cx: number } | null;
};

/**
 * Infinite horizontal strip:
 * 3 copies of slides → stay in the middle copy via ±setWidth jumps on scrollLeft.
 * Peel host reads the same scrollLeft for layout.
 */
export function bindGalleryScroll(
  scroller: HTMLElement,
  track: HTMLElement,
  options: GalleryScrollOptions = {},
): GalleryScroll {
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startScroll = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0;
  let snapDelay: gsap.core.Tween | null = null;
  let setWidth = 0;
  let setCount = 0;

  const slides = () =>
    Array.from(track.children).filter((n): n is HTMLElement => n instanceof HTMLElement);

  function measureSetWidth(): number {
    const list = slides();
    if (setCount <= 0 || list.length < setCount * 2) return 0;
    return list[setCount]!.offsetLeft - list[0]!.offsetLeft;
  }

  function buildLoop() {
    const originals = slides();
    setCount = originals.length;
    if (setCount === 0) return;

    // two extra copies → 3 sets total
    for (let c = 0; c < 2; c++) {
      for (const slide of originals) {
        const clone = slide.cloneNode(true) as HTMLElement;
        clone.setAttribute("data-loop-clone", "true");
        track.appendChild(clone);
      }
    }

    setWidth = measureSetWidth();
  }

  /** Keep scrollLeft inside the middle set [setWidth, 2*setWidth). */
  function normalizeLoop(): number {
    if (setWidth <= 0) return 0;
    let delta = 0;
    while (scroller.scrollLeft < setWidth) {
      scroller.scrollLeft += setWidth;
      delta += setWidth;
    }
    while (scroller.scrollLeft >= setWidth * 2) {
      scroller.scrollLeft -= setWidth;
      delta -= setWidth;
    }
    return delta;
  }

  function wrapIntoMiddle(x: number): number {
    if (setWidth <= 0) return Math.max(0, x);
    while (x < setWidth) x += setWidth;
    while (x >= setWidth * 2) x -= setWidth;
    return x;
  }

  function rawScrollLeftForSlide(slide: HTMLElement): number {
    return slide.offsetLeft + slide.offsetWidth / 2 - scroller.clientWidth / 2;
  }

  function scrollLeftForSlide(slide: HTMLElement): number {
    return wrapIntoMiddle(rawScrollLeftForSlide(slide));
  }

  /**
   * Pick scroll target for a slide in a given direction so we never ease backward
   * when the user asked for next (loop clones + wrapIntoMiddle caused that).
   */
  function scrollLeftInDirection(slide: HTMLElement, direction: 1 | -1): number {
    let target = rawScrollLeftForSlide(slide);
    if (setWidth <= 0) return target;
    const cur = scroller.scrollLeft;
    if (direction > 0) {
      while (target <= cur + 1) target += setWidth;
    } else {
      while (target >= cur - 1) target -= setWidth;
    }
    return target;
  }

  function nearestSlide(): HTMLElement | null {
    const list = slides();
    if (!list.length) return null;
    const viewCenter = scroller.scrollLeft + scroller.clientWidth / 2;
    let best = list[0]!;
    let bestDist = Infinity;
    for (const slide of list) {
      const c = slide.offsetLeft + slide.offsetWidth / 2;
      const d = Math.abs(c - viewCenter);
      if (d < bestDist) {
        bestDist = d;
        best = slide;
      }
    }
    return best;
  }

  function slideFromClientX(clientX: number): { el: HTMLElement; cx: number } | null {
    const rect = scroller.getBoundingClientRect();
    const viewX = clientX - rect.left;

    const warped = options.resolveSlideAt?.(viewX);
    if (warped) return warped;

    // Fallback: layout space (empty hit model)
    const x = scroller.scrollLeft + viewX;
    let best: HTMLElement | null = null;
    let bestCx = 0;
    let bestDist = Infinity;
    for (const slide of slides()) {
      const left = slide.offsetLeft;
      const right = left + slide.offsetWidth;
      const cx = (left + right) / 2;
      if (x >= left && x <= right) return { el: slide, cx };
      const d = Math.abs(cx - x);
      if (d < bestDist) {
        bestDist = d;
        best = slide;
        bestCx = cx;
      }
    }
    return best ? { el: best, cx: bestCx } : null;
  }

  function goToSlide(slide: HTMLElement, duration = 0.55, direction?: 1 | -1) {
    gsap.killTweensOf(scroller);
    snapDelay?.kill();
    // Interrupted tweens can sit past the middle set; re-enter before planning.
    normalizeLoop();

    const cur = scroller.scrollLeft;
    let target =
      direction === undefined
        ? scrollLeftForSlide(slide)
        : scrollLeftInDirection(slide, direction);

    if (setWidth > 0) {
      // Prefer a target within ±1 set of current (short hop on the 3× strip).
      while (target - cur > setWidth * 1.5) target -= setWidth;
      while (cur - target > setWidth * 1.5) target += setWidth;

      // Keep the whole tween on-strip: identical clone jump, then ease inside.
      // (Do not normalizeLoop here — that would undo the jump.)
      while (target >= setWidth * 2) {
        scroller.scrollLeft -= setWidth;
        target -= setWidth;
      }
      while (target < setWidth) {
        scroller.scrollLeft += setWidth;
        target += setWidth;
      }
    }

    gsap.to(scroller, {
      scrollLeft: target,
      duration,
      ease: "power3.out",
      overwrite: true,
      onComplete: () => normalizeLoop(),
    });
  }

  function snap(duration = 0.55) {
    const slide = nearestSlide();
    if (!slide) return;
    goToSlide(slide, duration);
  }

  function scheduleSnap(delay = 0.12) {
    snapDelay?.kill();
    snapDelay = gsap.delayedCall(delay, () => snap(0.4));
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    // Let flat live cards handle text select / focus without starting a drag.
    if (e.target instanceof Element && e.target.closest(".shot.is-live")) return;
    gsap.killTweensOf(scroller);
    snapDelay?.kill();
    normalizeLoop();
    dragging = true;
    moved = false;
    velocity = 0;
    startX = lastX = e.clientX;
    startScroll = scroller.scrollLeft;
    lastT = performance.now();
    scroller.setPointerCapture(e.pointerId);
    scroller.classList.add("is-dragging");
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const now = performance.now();
    const frameDx = e.clientX - lastX;
    if (Math.abs(e.clientX - startX) > 3) moved = true;

    // Relative drag — survives infinite-loop wraps without startScroll desync
    scroller.scrollLeft -= frameDx;
    normalizeLoop();

    const dt = Math.max(1, now - lastT);
    velocity = frameDx / dt;
    lastX = e.clientX;
    lastT = now;
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    scroller.classList.remove("is-dragging");
    try {
      scroller.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }

    // click → center the pressed (visually warped) card
    if (!moved) {
      const hit = slideFromClientX(e.clientX);
      if (hit) {
        const viewMid = scroller.clientWidth / 2;
        const usingWarp = Boolean(options.resolveSlideAt);
        const slideCenter = usingWarp
          ? hit.cx
          : hit.el.offsetLeft + hit.el.offsetWidth / 2 - scroller.scrollLeft;
        const delta = slideCenter - viewMid;
        if (Math.abs(delta) < 4) goToSlide(hit.el);
        else goToSlide(hit.el, 0.55, delta > 0 ? 1 : -1);
      }
      return;
    }

    const throwPx = -velocity * 180;
    normalizeLoop();
    let target = scroller.scrollLeft + throwPx;
    if (setWidth > 0) {
      while (target >= setWidth * 2) {
        scroller.scrollLeft -= setWidth;
        target -= setWidth;
      }
      while (target < setWidth) {
        scroller.scrollLeft += setWidth;
        target += setWidth;
      }
    }
    gsap.to(scroller, {
      scrollLeft: target,
      duration: 0.35,
      ease: "power2.out",
      overwrite: true,
      onComplete: () => {
        normalizeLoop();
        snap(0.45);
      },
    });
  }

  function onWheel(e: WheelEvent) {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (dx === 0) return;
    e.preventDefault();
    gsap.killTweensOf(scroller);
    scroller.scrollLeft += dx;
    normalizeLoop();
    scheduleSnap();
  }

  function onClickCapture(e: MouseEvent) {
    if (moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onResize() {
    setWidth = measureSetWidth();
    normalizeLoop();
  }

  buildLoop();

  scroller.addEventListener("pointerdown", onPointerDown);
  scroller.addEventListener("pointermove", onPointerMove);
  scroller.addEventListener("pointerup", onPointerUp);
  scroller.addEventListener("pointercancel", onPointerUp);
  scroller.addEventListener("wheel", onWheel, { passive: false });
  scroller.addEventListener("click", onClickCapture, true);
  window.addEventListener("resize", onResize);

  requestAnimationFrame(() => {
    setWidth = measureSetWidth();
    const list = slides();
    const midFirst = list[setCount];
    if (midFirst) {
      scroller.scrollLeft = scrollLeftForSlide(midFirst);
      normalizeLoop();
    }
  });

  return {
    getSetWidth: () => setWidth,
    destroy: () => {
      snapDelay?.kill();
      gsap.killTweensOf(scroller);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("pointermove", onPointerMove);
      scroller.removeEventListener("pointerup", onPointerUp);
      scroller.removeEventListener("pointercancel", onPointerUp);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("resize", onResize);
      track.querySelectorAll("[data-loop-clone]").forEach((n) => n.remove());
    },
  };
}
