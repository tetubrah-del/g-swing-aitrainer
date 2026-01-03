import type { PoseMetrics } from "@/app/lib/swing/poseMetrics";

export type AnalyzerOutsideInStatus = "confirmed" | "tendency" | "none" | "unknown";

export type SwingAnalyzerProfile = {
  level: {
    label: "プロ" | "上級" | "中級" | "初中級" | "初級" | "判定不能";
    zoneStayRatio?: number | null;
  };
  outsideIn: {
    status: AnalyzerOutsideInStatus;
    valueCm?: number | null;
    primaryDeviation?: string | null;
  };
  handVsChest?: {
    ratio?: number | null;
    classification?: string | null;
  };
  lowerBodyLead?: {
    lead?: string | null;
    deltaFrames?: number | null;
  };
  stability?: {
    headSway?: number | null;
    kneeSway?: number | null;
  };
};

const readNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const readString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const parseZoneStayRatio = (value: unknown): number | null => {
  const n = readNumber(value);
  if (n != null) return n;
  const s = readString(value);
  if (!s) return null;
  const matched = s.match(/-?\d+(?:\.\d+)?/);
  if (!matched) return null;
  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) ? parsed : null;
};

const deriveLevelLabel = (ratio: number | null): SwingAnalyzerProfile["level"]["label"] => {
  if (ratio == null || !Number.isFinite(ratio)) return "判定不能";
  if (ratio >= 90) return "プロ";
  if (ratio >= 80) return "上級";
  if (ratio >= 70) return "中級";
  if (ratio >= 60) return "初中級";
  return "初級";
};

const deriveOutsideInStatus = (value: number | null, primary: string | null): AnalyzerOutsideInStatus => {
  if (value == null || !Number.isFinite(value)) {
    if (primary === "outside") return "tendency";
    if (primary === "inside") return "none";
    return "unknown";
  }
  if (value >= 4) return "confirmed";
  if (value >= 2.5) return "tendency";
  if (value <= -2.5) return "none";
  if (primary === "outside") return "tendency";
  if (primary === "inside") return "none";
  return "none";
};

export function buildSwingAnalyzerProfile(params: {
  poseMetrics?: PoseMetrics | null;
  onPlane?: unknown;
}): SwingAnalyzerProfile {
  const onPlane = (params.onPlane ?? null) as Record<string, unknown> | null;
  const zoneStayRatio = parseZoneStayRatio(onPlane?.zone_stay_ratio_value ?? onPlane?.zone_stay_ratio);
  const primaryDeviation = readString(onPlane?.primary_deviation ?? onPlane?.primaryDeviation);
  const topToDownswing = readNumber(onPlane?.top_to_downswing_cm ?? onPlane?.topToDownswingCm ?? onPlane?.top_to_downswing);
  const lateDownswing = readNumber(onPlane?.late_downswing_cm ?? onPlane?.lateDownswingCm ?? onPlane?.downswing_late_cm ?? onPlane?.downswingLateCm);
  const outsideValue = topToDownswing ?? lateDownswing ?? null;

  const poseMetrics = params.poseMetrics ?? null;
  const handVsChest = poseMetrics?.metrics.handVsChest ?? null;
  const lowerBodyLead = poseMetrics?.metrics.lowerBodyLead ?? null;
  const headSway = poseMetrics?.metrics.headSway?.distNorm ?? null;
  const kneeSway = poseMetrics?.metrics.kneeSway?.distNorm ?? null;

  return {
    level: {
      label: deriveLevelLabel(zoneStayRatio),
      zoneStayRatio,
    },
    outsideIn: {
      status: deriveOutsideInStatus(outsideValue, primaryDeviation),
      valueCm: outsideValue,
      primaryDeviation,
    },
    handVsChest: handVsChest
      ? {
          ratio: readNumber(handVsChest.ratio),
          classification: readString(handVsChest.classification),
        }
      : undefined,
    lowerBodyLead: lowerBodyLead
      ? {
          lead: readString(lowerBodyLead.lead),
          deltaFrames: readNumber(lowerBodyLead.deltaFrames),
        }
      : undefined,
    stability: {
      headSway,
      kneeSway,
    },
  };
}

export function buildAnalyzerPromptBlock(profile: SwingAnalyzerProfile | null): string {
  if (!profile) return "なし";
  const lines = [
    `レベル推定: ${profile.level.label}${profile.level.zoneStayRatio != null ? ` (zone_stay_ratio=${profile.level.zoneStayRatio.toFixed(1)}%)` : ""}`,
    `アウトサイドイン: ${profile.outsideIn.status}${profile.outsideIn.valueCm != null ? ` (Top→DS=${profile.outsideIn.valueCm.toFixed(1)}cm)` : ""}`,
    profile.handVsChest?.ratio != null
      ? `手打ち/振り遅れ: ${profile.handVsChest.classification ?? "unknown"} (ratio=${profile.handVsChest.ratio.toFixed(2)})`
      : "手打ち/振り遅れ: データ不足",
    profile.lowerBodyLead?.deltaFrames != null
      ? `下半身始動: ${profile.lowerBodyLead.lead ?? "unknown"} (deltaFrames=${profile.lowerBodyLead.deltaFrames})`
      : "下半身始動: データ不足",
    profile.stability?.headSway != null ? `頭のブレ: ${profile.stability.headSway.toFixed(2)}x` : "頭のブレ: --",
    profile.stability?.kneeSway != null ? `膝のブレ: ${profile.stability.kneeSway.toFixed(2)}x` : "膝のブレ: --",
  ];
  return lines.join("\n");
}

export function applyAnalyzerOutsideInAdjustments(params: {
  phases: Record<string, { score?: number; issues?: string[]; advice?: string[] }>;
  majorNg?: Partial<Record<string, boolean>>;
  midHighOk?: Partial<Record<string, boolean>>;
  profile: SwingAnalyzerProfile | null;
}): {
  phases: Record<string, { score?: number; issues?: string[]; advice?: string[] }>;
  majorNg?: Partial<Record<string, boolean>>;
  midHighOk?: Partial<Record<string, boolean>>;
  applied: boolean;
} {
  const profile = params.profile;
  if (!profile) return { ...params, applied: false };
  const status = profile.outsideIn.status;
  const phases = params.phases;
  const downswing = phases.downswing ?? null;
  if (!downswing) return { ...params, applied: false };

  let applied = false;
  if (status === "confirmed") {
    downswing.issues = Array.from(new Set(["アウトサイドイン（確定）", ...(downswing.issues ?? [])]));
    downswing.issues = downswing.issues.filter((t) => !/外から入りやすい傾向/.test(String(t)));
    if (typeof downswing.score === "number") downswing.score = Math.min(downswing.score, 8);
    params.majorNg = { ...(params.majorNg ?? {}), downswing: true };
    params.midHighOk = { ...(params.midHighOk ?? {}), downswing: false };
    applied = true;
  } else if (status === "tendency") {
    downswing.issues = Array.from(new Set(["外から入りやすい傾向", ...(downswing.issues ?? [])]));
    if (typeof downswing.score === "number") downswing.score = Math.min(downswing.score, 12);
    params.midHighOk = { ...(params.midHighOk ?? {}), downswing: false };
    applied = true;
  }

  return { phases, majorNg: params.majorNg, midHighOk: params.midHighOk, applied };
}

export function applyAnalyzerPhaseAdjustments(params: {
  phases: Record<string, { score?: number; issues?: string[]; advice?: string[] }>;
  profile: SwingAnalyzerProfile | null;
}): { phases: Record<string, { score?: number; issues?: string[]; advice?: string[] }>; applied: boolean } {
  const profile = params.profile;
  if (!profile) return { phases: params.phases, applied: false };
  const phases = params.phases;
  const downswing = phases.downswing ?? null;
  if (!downswing) return { phases, applied: false };

  let applied = false;
  const classification = profile.handVsChest?.classification ?? null;
  if (classification === "hand_first") {
    downswing.issues = Array.from(new Set(["手打ち傾向", ...(downswing.issues ?? [])]));
    if (typeof downswing.score === "number") downswing.score = Math.min(downswing.score, 13);
    applied = true;
  } else if (classification === "torso_first") {
    downswing.issues = Array.from(new Set(["振り遅れ傾向", ...(downswing.issues ?? [])]));
    if (typeof downswing.score === "number") downswing.score = Math.min(downswing.score, 13);
    applied = true;
  }

  if (profile.lowerBodyLead?.lead === "chest") {
    downswing.issues = Array.from(new Set(["上半身先行", ...(downswing.issues ?? [])]));
    if (typeof downswing.score === "number") downswing.score = Math.min(downswing.score, 13);
    applied = true;
  }

  return { phases, applied };
}
