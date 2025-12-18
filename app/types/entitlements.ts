export type EntitlementTier = "anonymous" | "free" | "pro";

export type CapabilityKey =
  // 1) 診断・分析（コア価値）
  | "analysis.create"
  | "analysis.advanced_metrics"
  | "analysis.compare"
  // 2) AIコーチ（継続課金の核）
  | "coach.chat"
  | "coach.priority"
  // 3) 履歴・可視化（PRO感）
  | "history.list"
  | "history.graph"
  // 4) 動画・データ管理（コスト制御）
  | "video.upload"
  | "video.priority_processing"
  // 5) エクスポート・外部連携
  | "export.pdf"
  | "export.csv"
  // 6) UX・制限解除
  | "ux.ads_hidden"
  | "ux.watermark_hidden";

export type QuotaKey =
  | "analysis.monthly_limit"
  | "coach.monthly_messages"
  | "history.retention_days"
  | "video.max_uploads"
  | "video.max_seconds"
  | "storage.gb";

export type Entitlements = {
  tier: EntitlementTier;
  capabilities: Record<CapabilityKey, boolean>;
  quotas: Record<QuotaKey, number | null>;
  billingProvider: "none" | "stripe" | "apple" | "google" | "revenuecat";
};

