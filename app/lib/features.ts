export type FeatureFlags = {
  analyze: boolean;
  coach: "free_chat" | "guided";
  historyDepth: "full" | "latest_only";
  charts: boolean;
  comparison: boolean;
};

export function getFeatures(params: { remainingCount: number | null | undefined; isPro: boolean }): FeatureFlags {
  const remaining = typeof params.remainingCount === "number" && Number.isFinite(params.remainingCount) ? params.remainingCount : 0;
  const isPro = params.isPro === true;

  return {
    analyze: remaining > 0 || isPro,
    coach: isPro ? "free_chat" : "guided",
    historyDepth: isPro ? "full" : "latest_only",
    charts: isPro,
    comparison: isPro,
  };
}

