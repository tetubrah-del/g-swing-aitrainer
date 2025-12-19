import { CausalImpactExplanation, GolfAnalyzeMeta, SwingAnalysis } from "@/app/golf/types";

type RoundEstimates = {
  strokeRange?: string;
  ob?: string | number;
};

type RulePayload = {
  result?: SwingAnalysis;
  totalScore?: number;
  phases?: SwingAnalysis["phases"];
  summary?: string;
  meta?: GolfAnalyzeMeta | null;
  roundEstimates?: RoundEstimates;
};

const PHASE_WEIGHT: Record<keyof SwingAnalysis["phases"], number> = {
  impact: 0.35,
  downswing: 0.3,
  top: 0.18,
  address: 0.12,
  finish: 0.1,
};

const ISSUE_RULES = [
  {
    key: "unstable_face",
    patterns: [/フェース/, /face/i, /開き/],
    issue: "フェース管理がやや不安定",
    relatedMiss: "インパクトでフェース向きが安定しない",
    nextAction: "ハーフスイングでフェース向きを一定に保つ練習を10球",
    weight: 1.35,
  },
  {
    key: "early_open_body",
    patterns: [/体.*開/, /開きが早/],
    issue: "切り返しで体が先に開く",
    relatedMiss: "アウトサイドイン軌道になり左右ブレが増える",
    nextAction: "切り返しで胸をターゲットに向けるのを0.2秒遅らせる",
    weight: 1.25,
  },
  {
    key: "weak_grip",
    patterns: [/グリップ/],
    issue: "グリッププレッシャーが安定しない",
    relatedMiss: "インパクトでフェースが暴れやすい",
    nextAction: "アドレスでグリップ圧を左右均等に保つ素振りを5回",
    weight: 1.05,
  },
  {
    key: "balance_finish",
    patterns: [/フィニッシュ/, /バランス/],
    issue: "フィニッシュでバランスが崩れる",
    relatedMiss: "体重移動が足りず再現性が下がる",
    nextAction: "左足一本素振りでフィニッシュを5回キープ",
    weight: 0.95,
  },
];

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const parseObEstimate = (ob?: string | number | null): number | undefined => {
  if (typeof ob === "number" && Number.isFinite(ob)) return ob;
  if (typeof ob === "string") {
    const m = ob.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
};

const pickRule = (text: string) => {
  return ISSUE_RULES.find((rule) => rule.patterns.some((p) => p.test(text)));
};

const buildChain = (issue: string, relatedMiss: string, obDelta?: number, scoreDelta?: number): string[] => {
  const chain: string[] = [issue, relatedMiss];
  if (typeof obDelta === "number") chain.push(`OB +${obDelta.toFixed(1)}回（18H換算）`);
  if (typeof scoreDelta === "number") chain.push(`推定スコア +${scoreDelta}打`);
  return chain;
};

export function buildRuleBasedCausalImpact(payload: RulePayload): CausalImpactExplanation {
  const totalScoreRaw = payload.totalScore ?? payload.result?.totalScore ?? 0;
  const totalScore = clamp(Number.isFinite(totalScoreRaw) ? Number(totalScoreRaw) : 0, 0, 100);
  const phases = payload.phases ?? payload.result?.phases;
  const summary = payload.summary ?? payload.result?.summary;

  let best = {
    issue: summary?.split("\n")?.[0]?.trim() || "スイングの再現性が不足",
    relatedMiss: "打点と方向性が乱れやすい",
    nextAction: "ハーフスイングでフェース向きを一定に保つ練習を10球",
    weight: 0.8,
  };

  if (phases) {
    const entries = Object.entries(phases) as Array<
      [keyof typeof phases, (typeof phases)[keyof typeof phases]]
    >;
    for (const [phaseKey, phase] of entries) {
      const phaseWeight = PHASE_WEIGHT[phaseKey] ?? 0.1;
      const phaseScoreBonus = (20 - (phase?.score ?? 20)) / 25; // low score => higher weight
      (phase?.issues ?? []).forEach((text) => {
        const rule = text ? pickRule(text) : undefined;
        const baseWeight = rule?.weight ?? 1.0;
        const weight = baseWeight + phaseWeight + phaseScoreBonus;
        if (weight > best.weight) {
          best = {
            issue: rule?.issue ?? text ?? best.issue,
            relatedMiss:
              rule?.relatedMiss ??
              (text?.includes("フェース") || text?.includes("開き")
                ? "フェース管理が不安定"
                : text?.includes("体重") || text?.includes("重心")
                  ? "軌道とコンタクトがぶれる"
                  : "打点と方向性が乱れやすい"),
            nextAction: rule?.nextAction ?? best.nextAction,
            weight,
          };
        }
      });
    }
  }

  const obFromEstimate = parseObEstimate(payload.roundEstimates?.ob);
  const obDelta = obFromEstimate ?? clamp(3.2 - totalScore * 0.012, 0.6, 4.5);
  const scoreDelta = Math.max(1, Math.round(obDelta * 2.3 + (100 - totalScore) * 0.015));

  const confidence = best.weight >= 1.55 ? "high" : best.weight >= 1.15 ? "medium" : "low";
  const chain = buildChain(best.issue, best.relatedMiss, obDelta, scoreDelta);

  const noteParts = ["数値は推定です。最重要の1点のみ表示しています。"];
  if (scoreDelta <= 1) {
    noteParts.push("スコア差は僅差で、大きな崩れはありません。");
  }

  return {
    issue: best.issue,
    primaryIssue: best.issue,
    relatedMiss: best.relatedMiss,
    scoreImpact: {
      obDelta: Number.isFinite(obDelta) ? Number(obDelta.toFixed(1)) : undefined,
      scoreDelta,
    },
    chain,
    nextAction: {
      title: "次の練習で意識",
      content: best.nextAction,
    },
    confidence,
    source: "fallback",
    note: noteParts.join(" "),
  };
}
