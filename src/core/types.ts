export type PeelHost = {
  invalidate: () => void;
  requestFrame: () => void;
  destroy: () => void;
};
