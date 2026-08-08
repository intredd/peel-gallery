/** Host surface for the peel gallery renderer. */
export type PeelHost = {
  /** Rebuild card textures from DOM. */
  invalidate: () => void;
  /** Schedule a peel redraw (scroll / tuner / etc.). */
  requestFrame: () => void;
  destroy: () => void;
};
