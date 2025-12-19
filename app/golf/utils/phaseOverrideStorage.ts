export type ManualPhaseOverride = {
  analysisId: string;
  downswing?: number; // 1-based sequence frame index
  impact?: number; // 1-based sequence frame index
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

export const loadPhaseOverride = (analysisId: string): ManualPhaseOverride | null => {
  if (!analysisId || typeof window === "undefined") return null;
  const parsed = safeParse<Partial<ManualPhaseOverride>>(window.localStorage.getItem(KEY(analysisId)));
  if (!parsed || parsed.analysisId !== analysisId) return null;
  const updatedAt = typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
  return {
    analysisId,
    downswing: normalizeIndex(parsed.downswing),
    impact: normalizeIndex(parsed.impact),
    updatedAt,
  };
};

export const savePhaseOverride = (analysisId: string, next: { downswing?: number; impact?: number }): ManualPhaseOverride | null => {
  if (!analysisId || typeof window === "undefined") return null;
  const current = loadPhaseOverride(analysisId);
  const merged: ManualPhaseOverride = {
    analysisId,
    downswing: normalizeIndex(next.downswing ?? current?.downswing),
    impact: normalizeIndex(next.impact ?? current?.impact),
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

