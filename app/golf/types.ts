// app/golf/types.ts

// 診断結果を識別するID
export type AnalysisId = string;

export interface SwingPhase {
  score: number; // 0-20
  good: string[];
  issues: string[];
  advice: string[];
}

export type SequenceStageKey =
  | "address"
  | "address_to_backswing"
  | "backswing_to_top"
  | "top_to_downswing"
  | "downswing_to_impact"
  | "finish";

export interface SequenceStageFeedback {
  stage: SequenceStageKey;
  headline: string;
  details: string[];
  keyFrameIndices?: number[];
}

export interface SequenceReview {
  frames: Array<{ url: string; timestampSec?: number }>;
  stages?: SequenceStageFeedback[];
}

export interface CausalImpactExplanation {
  issue: string;
  primaryIssue?: string;
  relatedMiss: string;
  scoreImpact: {
    obDelta?: number;
    scoreDelta: number;
  };
  chain?: string[];
  confidence?: "high" | "medium" | "low";
  nextAction?: {
    title: string;
    content: string;
  };
  source?: "ai" | "rule" | "fallback";
  note?: string;
}

export interface SwingAnalysis {
  analysisId: string;
  createdAt: string;
  totalScore: number; // 0-100
  phases: {
    address: SwingPhase;
    backswing: SwingPhase;
    top: SwingPhase;
    downswing: SwingPhase;
    impact: SwingPhase;
    finish: SwingPhase;
  };
  summary: string;
  recommendedDrills?: string[];
  comparison?: {
    improved: string[];
    regressed: string[];
  };
  sequence?: SequenceReview;
  on_plane?: unknown;
  swingStyle?: import("@/app/lib/swing/style").SwingStyleAssessment;
  swingStyleChange?: import("@/app/lib/swing/style").SwingStyleChange;
  swingStyleComment?: string;
}

// POST /api/golf/analyze に渡ってくるメタ情報
export interface GolfAnalyzeMeta {
  handedness: "right" | "left";
  clubType: "driver" | "iron" | "wedge";
  level: "beginner" | "beginner_plus" | "intermediate" | "upper_intermediate" | "advanced";
  sourceVideoUrl?: string | null;
  videoUrl?: string | null;
  previousAnalysisId?: AnalysisId | null;
  impactIndex?: number;
  scoringVersion?: string;
  /**
   * Version tag for reevaluation logic (server-side). Bumped when reevaluation heuristics change,
   * so the same `phaseOverrideSig` can be recomputed once after deployment.
   */
  phaseReevalVersion?: string;
  /**
   * Signature of the last user-selected phase-frame overrides used to generate the current result.
   * Used to avoid re-running nondeterministic vision evaluation when the override set is unchanged.
   */
  phaseOverrideSig?: string;
  /**
   * Last applied override frame indices (1-based, as shown in the UI).
   */
  phaseOverrideFrames?: Partial<Record<"address" | "backswing" | "top" | "downswing" | "impact" | "finish", number[]>>;
}

export type AuthProvider = "google" | "email";
export type ProAccessReason = "paid" | "monitor";

export type UserUsageState = {
  isAuthenticated: boolean;
  hasProAccess: boolean;
  isMonitor?: boolean;
  plan?: "anonymous" | "free" | "pro";
  entitlements?: import("@/app/types/entitlements").Entitlements;
  email?: string | null;
  userId?: string | null;
  anonymousUserId?: string | null;
  freeAnalysisCount?: number;
  authProvider?: AuthProvider | null;
  monthlyAnalysis?: {
    used: number;
    limit: number | null;
    remaining: number | null;
  };
};

export interface UserAccount {
  userId: string;
  email: string | null;
  nickname?: string | null;
  authProvider: AuthProvider | null;
  emailVerifiedAt?: number | null;
  lastLoginAt?: number | null;
  lastAnalysisAt?: number | null;
  isDisabled?: boolean;
  disabledAt?: number | null;
  disabledReason?: string | null;
  createdAt: number;
  updatedAt: number;
  proAccess: boolean;
  proAccessReason: ProAccessReason | null;
  proAccessExpiresAt: number | null;
  billingProvider?: "none" | "stripe" | "apple" | "google" | "revenuecat" | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
  currentPeriodEnd?: number | null;
  cancelAtPeriodEnd?: boolean | null;
  trialEnd?: number | null;
  anonymousIds?: string[];
  plan?: "anonymous" | "free" | "pro";
  freeAnalysisCount?: number;
  freeAnalysisResetAt?: number | null;
  monitorExpiresAt?: number | null;
  withdrawRequestedAt?: number | null;
  withdrawScheduledAt?: number | null;
  withdrawReason?: string | null;
}

export type UserState = "anonymous" | "registered" | "pro";

export interface GolfAnalysisRecord {
  id: AnalysisId;
  result: SwingAnalysis;
  meta: GolfAnalyzeMeta;
  createdAt: number;
  userId?: string | null;
  anonymousUserId?: string | null;
}

export interface GolfAnalysisResponse {
  analysisId: AnalysisId;
  result: SwingAnalysis;
  causalImpact?: CausalImpactExplanation;
  note?: string;
  meta?: GolfAnalyzeMeta;
  createdAt?: number;
  userState?: UserUsageState;
}

// スイングタイプ判定（AI用）
export type SwingTypeKey =
  | "body_turn"
  | "arm_rotation"
  | "shallow"
  | "steep"
  | "hand_first"
  | "sweep"
  | "one_plane"
  | "two_plane";

export interface SwingTypeMatch {
  type: SwingTypeKey;
  label: string;
  matchScore: number; // 0-1
  reason: string;
}

export interface SwingTypeDetail {
  title: string;
  shortDescription: string;
  overview: string;
  characteristics: string[];
  recommendedFor: string[];
  advantages: string[];
  disadvantages: string[];
  commonMistakes: string[];
  cta: {
    headline: string;
    message: string;
    buttonText: string;
  };
}

export interface SwingTypeLLMResult {
  swingTypeMatch: SwingTypeMatch[];
  swingTypeDetails: Record<SwingTypeKey, SwingTypeDetail>;
  nextCoachingContext?: {
    description: string;
    promptInstruction: string;
  };
  source?: "ai" | "fallback";
  note?: string;
}

export type SwingAnalysisHistory = {
  analysisId: string;
  userId: string;
  createdAt: string;
  swingScore: number;
  estimatedOnCourseScore: string;
  swingType: string;
  priorityIssue: string;
  nextAction: string;
};

// MVP ダミー用のサンプル結果
export const MOCK_GOLF_ANALYSIS_RESULT: SwingAnalysis = {
  analysisId: "sample-id",
  createdAt: new Date().toISOString(),
  totalScore: 72,
  phases: {
    address: { score: 15, good: ["安定した前傾角"], issues: ["グリップが弱い"], advice: ["前傾を保ちつつグリッププレッシャーを均等に。"] },
    backswing: {
      score: 14,
      good: ["テークバックが滑らか"],
      issues: ["手元が早く上がりやすい"],
      advice: ["テークバックは肩で始動し、手元は低く長く引く意識で。"],
    },
    top: { score: 14, good: ["コンパクトなトップ"], issues: ["リストが硬い"], advice: ["トップでリストを柔らかく使い、捻転差を感じましょう。"] },
    downswing: {
      score: 13,
      good: ["下半身リードの意識"],
      issues: ["体の開きが早い"],
      advice: ["切り返し後も胸を閉じておき、下半身主導でインパクトへ。"],
    },
    impact: { score: 15, good: ["ハンドファースト気味"], issues: ["フェース管理が不安定"], advice: ["右手を我慢し、フェースローテーションを抑えて打ち抜きましょう。"] },
    finish: { score: 15, good: ["バランスの良いフィニッシュ"], issues: ["重心が右に残る"], advice: ["左足にしっかり体重を乗せて胸をターゲットへ向ける。"] },
  },
  summary: "全体として良いリズムですが、フェース管理と体重移動が伸びしろです。",
  recommendedDrills: [
    "ハーフスイングでフェース向きを一定に保つ練習を20球×3セット",
    "左足一本素振りでフィニッシュまでバランスを取る練習を15回×2セット",
  ],
  sequence: {
    frames: [],
    stages: [
      {
        stage: "address",
        headline: "アドレスの安定性",
        details: ["スタンス幅と前傾角は概ね適正"],
      },
      {
        stage: "address_to_backswing",
        headline: "テークバックの滑らかさ",
        details: ["ヘッドが内に入りすぎないよう注意"],
      },
      {
        stage: "backswing_to_top",
        headline: "トップでの捻転差",
        details: ["腕とクラブの一体感がやや不足"],
      },
      {
        stage: "top_to_downswing",
        headline: "切り返しのリズム",
        details: ["下半身リードを意識すると◎"],
      },
      {
        stage: "downswing_to_impact",
        headline: "インパクトゾーンの再現性",
        details: ["ハンドファーストを保ちつつフェース管理を安定化"],
      },
      {
        stage: "finish",
        headline: "フィニッシュのバランス",
        details: ["左足への体重移動を最後まで維持"],
      },
    ],
  },
};
