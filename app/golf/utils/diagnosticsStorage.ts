import type { CausalImpactExplanation, SwingTypeLLMResult } from "@/app/golf/types";

export type RoundEstimateMetrics = {
  strokeRange: string;
  fwKeep: string;
  gir: string;
  ob: string;
};

type StoredDiagnostics = {
  analysisId: string;
  phaseOverrideSig: string | null;
  savedAt: number;
  roundEstimates?: RoundEstimateMetrics;
  causalImpact?: CausalImpactExplanation;
  swingTypeLLM?: SwingTypeLLMResult;
};

const KEY_PREFIX = "golf_diagnostics:";

export function saveDiagnostics(params: {
  analysisId: string;
  phaseOverrideSig: string | null;
  roundEstimates?: RoundEstimateMetrics;
  causalImpact?: CausalImpactExplanation;
  swingTypeLLM?: SwingTypeLLMResult;
}) {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredDiagnostics = {
      analysisId: params.analysisId,
      phaseOverrideSig: params.phaseOverrideSig ?? null,
      savedAt: Date.now(),
      roundEstimates: params.roundEstimates,
      causalImpact: params.causalImpact,
      swingTypeLLM: params.swingTypeLLM,
    };
    window.localStorage.setItem(`${KEY_PREFIX}${params.analysisId}`, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export function loadDiagnostics(analysisId: string): StoredDiagnostics | null {
  if (typeof window === "undefined") return null;
  if (!analysisId) return null;
  try {
    const raw = window.localStorage.getItem(`${KEY_PREFIX}${analysisId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDiagnostics>;
    if (!parsed || typeof parsed.analysisId !== "string") return null;
    if (typeof parsed.savedAt !== "number") return null;
    return parsed as StoredDiagnostics;
  } catch {
    return null;
  }
}

export function clearDiagnostics(analysisId: string) {
  if (typeof window === "undefined") return;
  if (!analysisId) return;
  try {
    window.localStorage.removeItem(`${KEY_PREFIX}${analysisId}`);
  } catch {
    // ignore
  }
}
