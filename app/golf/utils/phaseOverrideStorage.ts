export type ManualPhaseOverride = {
  analysisId: string;
  backswing?: number[]; // 1-based sequence frame indices
  top?: number[]; // 1-based sequence frame indices
  downswing?: number[]; // 1-based sequence frame indices
  impact?: number[]; // 1-based sequence frame indices
  updatedAt: number; // epoch ms
};

const KEY = (analysisId: string) => `golf_phase_override_${analysisId}`;

const safeParse = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const normalizeIndex = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < 1) return undefined;
  return rounded;
};

const normalizeIndices = (value: unknown): number[] | undefined => {
  if (typeof value === "number") {
    const idx = normalizeIndex(value);
    return idx ? [idx] : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const indices = value.map((v) => normalizeIndex(v)).filter((v): v is number => typeof v === "number");
  const unique = Array.from(new Set(indices)).sort((a, b) => a - b);
  return unique.length ? unique : undefined;
};

export const loadPhaseOverride = (analysisId: string): ManualPhaseOverride | null => {
  if (!analysisId || typeof window === "undefined") return null;
  const parsed = safeParse<Partial<ManualPhaseOverride>>(window.localStorage.getItem(KEY(analysisId)));
  if (!parsed || parsed.analysisId !== analysisId) return null;
  const updatedAt = typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
  return {
    analysisId,
    // Backward compat: older records may store single number.
    backswing: normalizeIndices((parsed as { backswing?: unknown }).backswing),
    top: normalizeIndices((parsed as { top?: unknown }).top),
    downswing: normalizeIndices((parsed as { downswing?: unknown }).downswing),
    impact: normalizeIndices((parsed as { impact?: unknown }).impact),
    updatedAt,
  };
};

export const savePhaseOverride = (
  analysisId: string,
  next: {
    backswing?: number[] | number;
    top?: number[] | number;
    downswing?: number[] | number;
    impact?: number[] | number;
  }
): ManualPhaseOverride | null => {
  if (!analysisId || typeof window === "undefined") return null;
  const current = loadPhaseOverride(analysisId);
  const nextBackswing = normalizeIndices(next.backswing ?? current?.backswing);
  const nextTop = normalizeIndices(next.top ?? current?.top);
  const nextDownswing = normalizeIndices(next.downswing ?? current?.downswing);
  const nextImpact = normalizeIndices(next.impact ?? current?.impact);
  const merged: ManualPhaseOverride = {
    analysisId,
    backswing: nextBackswing,
    top: nextTop,
    downswing: nextDownswing,
    impact: nextImpact,
    updatedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(KEY(analysisId), JSON.stringify(merged));
    return merged;
  } catch {
    return merged;
  }
};

export const togglePhaseOverride = (
  analysisId: string,
  next: { backswing?: number; top?: number; downswing?: number; impact?: number }
): ManualPhaseOverride | null => {
  if (!analysisId || typeof window === "undefined") return null;
  const current = loadPhaseOverride(analysisId);
  const toggleList = (list: number[] | undefined, value?: number) => {
    const idx = normalizeIndex(value);
    const base = Array.isArray(list) ? [...list] : [];
    if (!idx) return base.length ? base : undefined;
    const set = new Set(base);
    if (set.has(idx)) set.delete(idx);
    else set.add(idx);
    const out = Array.from(set).sort((a, b) => a - b);
    return out.length ? out : undefined;
  };
  const merged: ManualPhaseOverride = {
    analysisId,
    backswing: toggleList(current?.backswing, next.backswing),
    top: toggleList(current?.top, next.top),
    downswing: toggleList(current?.downswing, next.downswing),
    impact: toggleList(current?.impact, next.impact),
    updatedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(KEY(analysisId), JSON.stringify(merged));
    return merged;
  } catch {
    return merged;
  }
};

export const clearPhaseOverride = (analysisId: string): void => {
  if (!analysisId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY(analysisId));
  } catch {
    // ignore
  }
};
