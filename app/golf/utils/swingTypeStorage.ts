import { SwingTypeLLMResult } from "@/app/golf/types";

const STORAGE_KEY = "swing_type_result";

export function saveSwingTypeResult(result: SwingTypeLLMResult | null) {
  if (typeof window === "undefined") return;
  try {
    if (!result) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
  } catch {
    // ignore
  }
}

export function loadSwingTypeResult(): SwingTypeLLMResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SwingTypeLLMResult;
    if (parsed && parsed.swingTypeDetails && parsed.swingTypeMatch) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
