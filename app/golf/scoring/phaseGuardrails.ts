import type { SwingAnalysis } from "@/app/golf/types";

export const PHASE_KEYS = ["address", "backswing", "top", "downswing", "impact", "finish"] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];
export type PhaseBoolMap = Partial<Record<PhaseKey, boolean>>;

type PhaseLike = { score: number; good: string[]; issues: string[]; advice: string[] };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

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

function buildPhaseText(phase?: Partial<PhaseLike> | null): string {
  if (!phase) return "";
  const parts: string[] = [];
  if (Array.isArray(phase.good)) parts.push(...phase.good);
  if (Array.isArray(phase.issues)) parts.push(...phase.issues);
  if (Array.isArray(phase.advice)) parts.push(...phase.advice);
  return parts.join("／");
}

export function deriveMajorNgFromText(params: { phases: Record<PhaseKey, PhaseLike>; summary?: string | null }): PhaseBoolMap | undefined {
  const { phases } = params;
  const patterns: Partial<Record<PhaseKey, RegExp[]>> = {
    downswing: [
      // Direct outside-in / over-the-top cues
      /アウトサイドイン/,
      /カット軌道/,
      /外から下り/,
      /外から入る/,
      /上から入る/,
      /かぶせ/,
      /カット打ち/,
      // Sequence/order breakdown
      /上半身先行/,
      /体の開き/,
      /早開き/,
      // Shoulder/chest opening (often described without "体の開き")
      /右肩.*開/,
      /左肩.*開/,
      /肩.*早.*開/,
      /肩が.*早く開/,
      /胸.*開/,
      /腕が外に放り出/,
      /腕が体の外/,
      /肘.*離れすぎ/,
      /右肘.*離れ/,
      /右肘.*体から離れ/,
      // Common collapse cue that often accompanies over-the-top in this dataset
      /右膝.*内側/,
      /膝.*内側.*入りすぎ/,
    ],
    impact: [/体勢崩壊/, /すくい打ち/],
    finish: [/ふらつ/, /静止でき/, /立っていられ/],
    address: [/つま先/, /かかと/, /バランス崩/],
  };

  const out: PhaseBoolMap = {};
  for (const key of PHASE_KEYS) {
    const rules = patterns[key];
    if (!rules?.length) continue;
    const text = buildPhaseText(phases[key]);
    if (text && rules.some((r) => r.test(text))) out[key] = true;
  }

  // Composite downswing rule: "rotation insufficient" + early wrist release often indicates over-the-top / cast.
  try {
    const dsText = buildPhaseText(phases.downswing);
    const hasUpperBodyIssue = /上半身/.test(dsText) && /(不足|回転が不足|回転不足|開き)/.test(dsText);
    const hasEarlyRelease = /(手首|コック|リリース)/.test(dsText) && /(早|解け|ほどけ)/.test(dsText);
    if (hasUpperBodyIssue && hasEarlyRelease) out.downswing = true;
  } catch {
    // ignore
  }

  return Object.keys(out).length ? out : undefined;
}

export function deriveMidHighOkFromText(params: { phases: Record<PhaseKey, PhaseLike>; summary?: string | null }): PhaseBoolMap | undefined {
  const { phases } = params;
  const out: PhaseBoolMap = {};
  const dsText = buildPhaseText(phases.downswing);
  if (
    dsText &&
    [
      /アウトサイドイン/,
      /カット軌道/,
      /外から下り/,
      /外から入る/,
      /上から入る/,
      /かぶせ/,
      /カット打ち/,
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
  majorNg?: PhaseBoolMap;
}): number {
  const { totalScore, phases, majorNg } = params;
  let capped = totalScore;
  const ds = phases.downswing?.score ?? 0;
  const ad = phases.address?.score ?? 0;
  const fin = phases.finish?.score ?? 0;

  if (ds <= 8) capped = Math.min(capped, 65);
  if (majorNg?.downswing === true) capped = Math.min(capped, 58);
  if (ad <= 8 && fin <= 8) capped = Math.min(capped, 60);

  return Math.max(0, Math.min(100, Math.round(capped)));
}

export function rescoreSwingAnalysis(params: {
  result: SwingAnalysis;
  majorNg?: PhaseBoolMap;
  midHighOk?: PhaseBoolMap;
  deriveFromText?: boolean;
}): SwingAnalysis {
  const { result, majorNg, midHighOk, deriveFromText = true } = params;
  const phases = result.phases as unknown as Record<PhaseKey, PhaseLike>;
  if (!phases) return result;

  const derivedMajorNg = deriveFromText ? deriveMajorNgFromText({ phases, summary: result.summary ?? null }) : undefined;
  const derivedMidHighOk = deriveFromText ? deriveMidHighOkFromText({ phases, summary: result.summary ?? null }) : undefined;
  const mergedMajorNg = mergePhaseBoolMaps(majorNg, derivedMajorNg);
  const mergedMidHighOk = mergePhaseBoolMaps(midHighOk, derivedMidHighOk);

  const guardedPhases = applyPhaseGuardrails({ phases, majorNg: mergedMajorNg, midHighOk: mergedMidHighOk });
  const rawTotal = computeRawTotalScoreFromPhases(guardedPhases);
  const totalScore = applyCrossPhaseTotalCaps({ totalScore: rawTotal, phases: guardedPhases, majorNg: mergedMajorNg });

  return {
    ...result,
    totalScore,
    phases: guardedPhases as unknown as SwingAnalysis["phases"],
  };
}
