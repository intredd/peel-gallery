import gsap from "gsap";

export type TickerFn = (time: number) => void;

// Once per app — Lenis/ST may share gsap.ticker.
export function prepareTicker(): void {
  gsap.ticker.lagSmoothing(0);
}

export function addTicker(fn: TickerFn): void {
  gsap.ticker.add(fn);
}

export function removeTicker(fn: TickerFn): void {
  gsap.ticker.remove(fn);
}
