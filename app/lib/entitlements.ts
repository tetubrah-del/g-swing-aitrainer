import type { Entitlements, EntitlementTier } from "@/app/types/entitlements";
import { ANONYMOUS_ANALYSIS_LIMIT, FREE_MONTHLY_ANALYSIS_LIMIT } from "@/app/lib/limits";

const empty = <T extends Record<string, unknown>>(obj: T): T => obj;

export function buildEntitlements(params: {
  tier: EntitlementTier;
  hasProAccess: boolean;
  billingProvider?: Entitlements["billingProvider"];
}): Entitlements {
  const billingProvider = params.billingProvider ?? (params.hasProAccess ? "stripe" : "none");

  if (params.hasProAccess) {
    return {
      tier: "pro",
      billingProvider,
      capabilities: empty({
        "analysis.create": true,
        "analysis.advanced_metrics": true,
        "analysis.compare": true,
        "coach.chat": true,
        "coach.priority": true,
        "history.list": true,
        "history.graph": true,
        "video.upload": true,
        "video.priority_processing": true,
        "export.pdf": true,
        "export.csv": true,
        "ux.ads_hidden": true,
        "ux.watermark_hidden": true,
      }),
      quotas: empty({
        "analysis.monthly_limit": null,
        "coach.monthly_messages": null,
        "history.retention_days": null,
        "video.max_uploads": null,
        "video.max_seconds": null,
        "storage.gb": null,
      }),
    };
  }

  if (params.tier === "anonymous") {
    return {
      tier: "anonymous",
      billingProvider,
      capabilities: empty({
        "analysis.create": true,
        "analysis.advanced_metrics": false,
        "analysis.compare": false,
        "coach.chat": false,
        "coach.priority": false,
        "history.list": false,
        "history.graph": false,
        "video.upload": true,
        "video.priority_processing": false,
        "export.pdf": false,
        "export.csv": false,
        "ux.ads_hidden": false,
        "ux.watermark_hidden": false,
      }),
      quotas: empty({
        "analysis.monthly_limit": ANONYMOUS_ANALYSIS_LIMIT,
        "coach.monthly_messages": 0,
        "history.retention_days": 0,
        "video.max_uploads": 3,
        "video.max_seconds": 30,
        "storage.gb": 0,
      }),
    };
  }

  // free
  return {
    tier: "free",
    billingProvider,
    capabilities: empty({
      "analysis.create": true,
      "analysis.advanced_metrics": false,
      "analysis.compare": false,
      "coach.chat": false,
      "coach.priority": false,
      "history.list": true,
      "history.graph": false,
      "video.upload": true,
      "video.priority_processing": false,
      "export.pdf": false,
      "export.csv": false,
      "ux.ads_hidden": false,
      "ux.watermark_hidden": false,
    }),
    quotas: empty({
      "analysis.monthly_limit": FREE_MONTHLY_ANALYSIS_LIMIT,
      "coach.monthly_messages": 0,
      "history.retention_days": 90,
      "video.max_uploads": 20,
      "video.max_seconds": 60,
      "storage.gb": 1,
    }),
  };
}
