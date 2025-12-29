import type { SwingAnalysis } from "@/app/golf/types";

export const PHASE_KEYS = ["address", "backswing", "top", "downswing", "impact", "finish"] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];
export type PhaseBoolMap = Partial<Record<PhaseKey, boolean>>;

type PhaseLike = { score: number; good: string[]; issues: string[]; advice: string[] };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Treat as "confirmed" only when explicitly marked, to avoid false positives.
const OUTSIDE_IN_CONFIRMED = /アウトサイドイン（確定）|カット軌道（確定）|外から下りる（確定）/;

export function mergePhaseBoolMaps(a?: PhaseBoolMap, b?: PhaseBoolMap): PhaseBoolMap | undefined {
  if (!a && !b) return undefined;
  const out: PhaseBoolMap = {};
  for (const key of PHASE_KEYS) {
    const av = a?.[key];
    const bv = b?.[key];
    if (av === true || bv === true) out[key] = true;
    else if (av === false || bv === false) out[key] = false;
  }
  return Object.keys(out).length ? out : undefined;
}

function buildIssuesText(phase?: Partial<PhaseLike> | null): string {
  if (!phase) return "";
  const issues = Array.isArray(phase.issues) ? phase.issues : [];
  return issues.join("／");
}

function isOutsideInConfirmedFromText(params: { phases: Record<PhaseKey, PhaseLike>; summary?: string | null }): boolean {
  try {
    const dsText = buildIssuesText(params.phases.downswing);
    // Only treat as "confirmed" when explicitly stated in the Downswing findings.
    // (The overall summary may mention outside-in as a generic suggestion and is too noisy.)
    return OUTSIDE_IN_CONFIRMED.test(dsText);
  } catch {
    return false;
  }
}

export function deriveMajorNgFromText(params: { phases: Record<PhaseKey, PhaseLike>; summary?: string | null }): PhaseBoolMap | undefined {
  const { phases } = params;
  const patterns: Partial<Record<PhaseKey, RegExp[]>> = {
    downswing: [
      // Confirmed outside-in only (avoid false positives on "tendency")
      OUTSIDE_IN_CONFIRMED,
      // Sequence/order breakdown (strong)
      /上半身先行/,
      /早開き/,
      // "opening too early" (strong) cues (avoid mild "少し早く開く")
      /開きが早/,
      /開き.*早すぎ/,
    ],
    impact: [
      /体勢崩壊/,
      /すくい打ち/,
      // Strong early-extension cues should be "confirmed" to avoid false positives.
      /早期伸展（確定）/,
      /骨盤.*前.*出.*（確定）/,
      /腰.*前.*出.*（確定）/,
      /前傾.*起き.*（確定）/,
      /腰の突っ込み.*（確定）/,
      /スペース.*潰.*（確定）/,
    ],
    finish: [/ふらつ/, /静止でき/, /立っていられ/],
    address: [/つま先/, /かかと/, /バランス崩/],
  };

  const out: PhaseBoolMap = {};
  for (const key of PHASE_KEYS) {
    const rules = patterns[key];
    if (!rules?.length) continue;
    const text = buildIssuesText(phases[key]);
    if (text && rules.some((r) => r.test(text))) out[key] = true;
  }

  return Object.keys(out).length ? out : undefined;
}

export function deriveMidHighOkFromText(params: { phases: Record<PhaseKey, PhaseLike>; summary?: string | null }): PhaseBoolMap | undefined {
  const { phases } = params;
  const out: PhaseBoolMap = {};
  const dsText = buildIssuesText(phases.downswing);
  if (
    dsText &&
    [
      OUTSIDE_IN_CONFIRMED,
      /上半身先行/,
      /早開き/,
      /体の開き/,
      /右肩.*開/,
      /左肩.*開/,
      /肩.*早.*開/,
      /肩が.*早く開/,
      /胸.*開/,
      /上半身.*回転.*不足/,
      /回転.*不足/,
      /手首.*コック.*早/,
      /コック.*早/,
      /肘.*離れすぎ/,
      /右肘.*離れ/,
    ].some((r) => r.test(dsText))
  ) {
    out.downswing = false;
  }

  const impText = buildIssuesText(phases.impact);
  if (
    impText &&
    [
      /体勢崩壊/,
      /すくい打ち/,
      /早期伸展（確定）/,
      /骨盤.*前.*出.*（確定）/,
      /腰.*前.*出.*（確定）/,
      /前傾.*起き.*（確定）/,
      /腰の突っ込み.*（確定）/,
      /スペース.*潰.*（確定）/,
    ].some((r) => r.test(impText))
  ) {
    out.impact = false;
  }
  return Object.keys(out).length ? out : undefined;
}

export function applyPhaseGuardrails(params: {
  phases: Record<PhaseKey, PhaseLike>;
  majorNg?: PhaseBoolMap;
  midHighOk?: PhaseBoolMap;
}): Record<PhaseKey, PhaseLike> {
  const { phases, majorNg, midHighOk } = params;

  const majorCaps: Record<PhaseKey, number> = {
    address: 10,
    backswing: 10,
    top: 10,
    downswing: 8,
    impact: 10,
    finish: 12,
  };

  const midHighCaps: Record<PhaseKey, number> = {
    address: 14,
    backswing: 13,
    top: 12,
    downswing: 10,
    impact: 12,
    finish: 14,
  };

  const next = { ...phases } as Record<PhaseKey, PhaseLike>;
  for (const key of PHASE_KEYS) {
    const current = next[key];
    const rawScore = clamp(Number.isFinite(current?.score) ? current.score : 0, 0, 20);
    let score = rawScore;
    if (majorNg?.[key] === true) score = Math.min(score, majorCaps[key]);
    if (midHighOk?.[key] === false) score = Math.min(score, midHighCaps[key]);
    next[key] = { ...current, score: clamp(Math.round(score), 0, 20) };
  }
  return next;
}

export function computeRawTotalScoreFromPhases(phases: Record<PhaseKey, PhaseLike>): number {
  const sum = PHASE_KEYS.reduce((acc, key) => acc + (phases[key]?.score ?? 0), 0);
  return Math.max(0, Math.min(100, Math.round((sum / (PHASE_KEYS.length * 20)) * 100)));
}

export function applyCrossPhaseTotalCaps(params: {
  totalScore: number;
  phases: Record<PhaseKey, PhaseLike>;
  outsideInConfirmed?: boolean;
}): number {
  const { totalScore, phases, outsideInConfirmed } = params;
  let capped = totalScore;
  const ds = phases.downswing?.score ?? 0;
  const ad = phases.address?.score ?? 0;
  const fin = phases.finish?.score ?? 0;

  if (ds <= 8) capped = Math.min(capped, 65);
  // Strongest total cap (58) only when outside-in is explicitly confirmed.
  if (outsideInConfirmed === true) capped = Math.min(capped, 58);
  if (ad <= 8 && fin <= 8) capped = Math.min(capped, 60);

  return Math.max(0, Math.min(100, Math.round(capped)));
}

export function rescoreSwingAnalysis(params: {
  result: SwingAnalysis;
  majorNg?: PhaseBoolMap;
  midHighOk?: PhaseBoolMap;
  deriveFromText?: boolean;
  outsideInConfirmed?: boolean;
}): SwingAnalysis {
  const { result, majorNg, midHighOk, deriveFromText = true, outsideInConfirmed } = params;
  const phases = result.phases as unknown as Record<PhaseKey, PhaseLike>;
  if (!phases) return result;

  const derivedMajorNg = deriveFromText ? deriveMajorNgFromText({ phases, summary: result.summary ?? null }) : undefined;
  const derivedMidHighOk = deriveFromText ? deriveMidHighOkFromText({ phases, summary: result.summary ?? null }) : undefined;
  const mergedMajorNg = mergePhaseBoolMaps(majorNg, derivedMajorNg);
  const mergedMidHighOk = mergePhaseBoolMaps(midHighOk, derivedMidHighOk);
  const confirmedByText = deriveFromText ? isOutsideInConfirmedFromText({ phases, summary: result.summary ?? null }) : false;
  const outsideIn = outsideInConfirmed === true || confirmedByText;

  // Apply "major NG" caps always (hard penalties).
  const majorGuarded = applyPhaseGuardrails({ phases, majorNg: mergedMajorNg });
  const majorTotal = computeRawTotalScoreFromPhases(majorGuarded);

  // Apply "mid-high (70+) minimum conditions" only when the score would otherwise be 70+.
  const guardedPhases =
    majorTotal >= 70
      ? applyPhaseGuardrails({ phases: majorGuarded, majorNg: mergedMajorNg, midHighOk: mergedMidHighOk })
      : majorGuarded;

  const rawTotal = computeRawTotalScoreFromPhases(guardedPhases);
  const totalScore = applyCrossPhaseTotalCaps({
    totalScore: rawTotal,
    phases: guardedPhases,
    outsideInConfirmed: outsideIn,
  });

  return {
    ...result,
    totalScore,
    phases: guardedPhases as unknown as SwingAnalysis["phases"],
  };
}
