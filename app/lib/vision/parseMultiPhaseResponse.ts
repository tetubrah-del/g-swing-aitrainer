import { SwingPhase } from "@/app/golf/types";
import { PhaseKey } from "./extractPhaseFrames";

const phaseKeys: PhaseKey[] = ["address", "top", "downswing", "impact", "finish"];

type RawResponse = Partial<Record<PhaseKey, unknown>> & {
  phases?: Partial<Record<PhaseKey, unknown>>;
  score?: unknown;
  totalScore?: unknown;
  summary?: unknown;
  recommendedDrills?: unknown;
  drills?: unknown;
  comparison?: unknown;
};

function ensureString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Field ${field} must be a string`);
  }
  return value;
}

function ensureStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Field ${field} must be an array of strings`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`Field ${field} must be an array of strings`);
    }
    return entry;
  });
}

function ensureNumber(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Field ${field} must be a finite number`);
  }
  return num;
}

function parsePhase(rawPhase: unknown, key: PhaseKey): SwingPhase {
  if (!rawPhase || typeof rawPhase !== "object") {
    throw new Error(`Phase ${key} must be an object`);
  }

  const phase = rawPhase as Record<string, unknown>;
  const score = ensureNumber(phase.score, `${key}.score`);

  return {
    score: Math.max(0, Math.min(20, Math.round(score))),
    good: ensureStringArray(phase.good ?? [], `${key}.good`),
    issues: ensureStringArray(phase.issues ?? [], `${key}.issues`),
    advice: ensureStringArray(phase.advice ?? [], `${key}.advice`),
  };
}

export function parseMultiPhaseResponse(input: unknown): {
  totalScore: number;
  summary: string;
  recommendedDrills?: string[];
  comparison?: { improved: string[]; regressed: string[] };
  phases: Record<PhaseKey, SwingPhase>;
} {
  let parsed: RawResponse;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input) as RawResponse;
    } catch (error) {
      throw new Error(`Failed to parse Vision API JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (input && typeof input === "object") {
    parsed = input as RawResponse;
  } else {
    throw new Error("Failed to parse Vision API JSON: invalid input type");
  }

  const phaseSource = parsed.phases && typeof parsed.phases === "object" ? parsed.phases : parsed;

  const phases = phaseKeys.reduce((acc, key) => {
    const rawPhase = (phaseSource as RawResponse)[key];
    if (!rawPhase) {
      throw new Error(`Missing phase: ${key}`);
    }
    acc[key] = parsePhase(rawPhase, key);
    return acc;
  }, {} as Record<PhaseKey, SwingPhase>);

  const explicitTotal = parsed.totalScore ?? parsed.score;
  const totalScore = typeof explicitTotal === "number" && Number.isFinite(explicitTotal)
    ? explicitTotal
    : phaseKeys.reduce((sum, key) => sum + phases[key].score, 0);

  return {
    totalScore: Math.max(0, Math.min(100, Math.round(totalScore))),
    summary: ensureString(parsed.summary ?? "", "summary"),
    recommendedDrills: parsed.recommendedDrills
      ? ensureStringArray(parsed.recommendedDrills, "recommendedDrills")
      : parsed.drills
        ? ensureStringArray(parsed.drills, "drills")
        : undefined,
    comparison:
      parsed.comparison && typeof parsed.comparison === "object"
        ? {
            improved: ensureStringArray((parsed.comparison as Record<string, unknown>).improved ?? [], "comparison.improved"),
            regressed: ensureStringArray((parsed.comparison as Record<string, unknown>).regressed ?? [], "comparison.regressed"),
          }
        : undefined,
    phases,
  };
}
