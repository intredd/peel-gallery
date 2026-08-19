import type { ShelfFieldParams } from "./effects/shelf-envelope";

const STORAGE_KEY = "peel-gallery/shelf-field";

const FIELD_KEYS: (keyof ShelfFieldParams)[] = [
  "innerPct",
  "shoulderPct",
  "vx1",
  "vy1",
  "vx2",
  "vy2",
  "maxScale",
  "minScale",
];

export function loadShelfField(): Partial<ShelfFieldParams> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<ShelfFieldParams> = {};
    for (const key of FIELD_KEYS) {
      const v = data[key];
      if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export function saveShelfField(field: ShelfFieldParams): void {
  const payload: Record<string, number> = {};
  for (const key of FIELD_KEYS) payload[key] = field[key];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}
