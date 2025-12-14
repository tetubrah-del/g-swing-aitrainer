import { CoachCausalImpactExplanation } from "@/app/coach/types";
import { CausalImpactExplanation } from "@/app/golf/types";

const confidenceToNumber = (confidence?: CausalImpactExplanation["confidence"]): number => {
  if (confidence === "high") return 0.9;
  if (confidence === "medium") return 0.6;
  if (confidence === "low") return 0.35;
  return 0.5;
};

export const buildCoachContext = (params: {
  causal?: CausalImpactExplanation | null;
  displayIssue?: string;
  chain?: string[];
  nextAction?: string;
  analysisId?: string;
  summary?: string;
  swingTypeHeadline?: string | null;
  analyzedAt?: string | null;
}): CoachCausalImpactExplanation => {
  const { causal, displayIssue, chain, nextAction, analysisId, summary, swingTypeHeadline, analyzedAt } = params;
  const primaryFactor =
    displayIssue || causal?.primaryIssue || causal?.issue || "スイングの再現性を高めること";
  const chainList =
    chain && chain.length
      ? chain
      : causal?.chain && causal.chain.length
        ? causal.chain
        : [primaryFactor, causal?.relatedMiss || "関連ミスを特定中"];
  const action =
    nextAction || causal?.nextAction?.content || causal?.nextAction?.title || "次の練習で同じリズムを10球繰り返す";

  return {
    analysisId,
    primaryFactor,
    chain: chainList.slice(0, 6),
    confidence: confidenceToNumber(causal?.confidence),
    nextAction: action,
    summary: summary?.slice(0, 360),
    swingTypeHeadline: swingTypeHeadline || null,
    analyzedAt: analyzedAt || null,
  };
};
