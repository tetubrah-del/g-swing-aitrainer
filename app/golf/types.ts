// app/golf/types.ts

// 診断結果を識別するID
export type AnalysisId = string;

export interface SwingPhase {
  score: number; // 0-20
  good: string[];
  issues: string[];
  advice: string[];
}

export interface SwingAnalysis {
  analysisId: string;
  createdAt: string;
  totalScore: number; // 0-100
  phases: {
    address: SwingPhase;
    top: SwingPhase;
    downswing: SwingPhase;
    impact: SwingPhase;
    finish: SwingPhase;
  };
  summary: string;
  recommendedDrills?: string[];
}

// POST /api/golf/analyze に渡ってくるメタ情報
export interface GolfAnalyzeMeta {
  handedness: "right" | "left";
  clubType: "driver" | "iron" | "wedge";
  level: "beginner" | "beginner_plus" | "intermediate" | "upper_intermediate" | "advanced";
  previousAnalysisId?: AnalysisId | null;
}

export interface GolfAnalysisRecord {
  id: AnalysisId;
  result: SwingAnalysis;
  meta: GolfAnalyzeMeta;
  createdAt: number;
}

export interface GolfAnalysisResponse {
  analysisId: AnalysisId;
  result: SwingAnalysis;
  note?: string;
  meta?: GolfAnalyzeMeta;
  createdAt?: number;
}

// MVP ダミー用のサンプル結果
export const MOCK_GOLF_ANALYSIS_RESULT: SwingAnalysis = {
  analysisId: "sample-id",
  createdAt: new Date().toISOString(),
  totalScore: 72,
  phases: {
    address: { score: 15, good: ["安定した前傾角"], issues: ["グリップが弱い"], advice: ["前傾を保ちつつグリッププレッシャーを均等に。"] },
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
};
