// app/golf/types.ts

// 診断結果を識別するID
export type AnalysisId = string;

// ゴルフ診断結果の型
export interface GolfAnalysisResult {
  score: number; // スイングスコア（100点満点）
  estimatedOnCourseScore: string; // 例: "90〜100"
  estimatedLevel: string; // 例: "中級寄りの初級"
  goodPoints: string[];
  badPoints: string[];
  priorityFix: string[]; // 最優先で直すポイント
  drills: string[]; // ドリル（回数/セットなど含めてもOK）
  improvement: {
    hasPrevious: boolean;
    direction: string; // "改善している" / "悪化している" / "変わらない" など
    changeSummary: string; // 前回からどう変わったか
    nextFocus: string; // 次に意識すべきポイント
  };
  summary: string; // まとめの短文
}

// POST /api/golf/analyze に渡ってくるメタ情報
export interface GolfAnalyzeMeta {
  handedness: "right" | "left";
  clubType: "driver" | "iron" | "wedge";
  level: "beginner" | "beginner_plus" | "intermediate" | "upper_intermediate" | "advanced";
  previousAnalysisId?: AnalysisId | null;
}

// MVP ダミー用のサンプル結果
export const MOCK_GOLF_ANALYSIS_RESULT: GolfAnalysisResult = {
  score: 78,
  estimatedOnCourseScore: "90〜100",
  estimatedLevel: "中級寄りの初級",
  goodPoints: [
    "アドレスのバランスがよく、下半身が安定している",
    "トップでクラブフェースが大きく開きすぎず、スクエア寄りで収まっている",
  ],
  badPoints: [
    "ダウンスイングで下半身のリードが弱く、上体から動き出している",
    "インパクトゾーンで右肩が前に出て、フェースのコントロールが不安定",
  ],
  priorityFix: [
    "ダウンスイングで『左腰→おへそ→胸』の順に回す感覚を身につける",
  ],
  drills: [
    "素振りドリル：右足を後ろに引いてかかと立ちにした状態で、腰リードを意識して素振りを20回 × 3セット",
    "ハーフスイングドリル：9時〜3時のハーフスイングで、フィニッシュまで振り切るショットを30球。すべて同じリズムで打つことを意識",
  ],
  improvement: {
    hasPrevious: false,
    direction: "初回診断のため比較なし",
    changeSummary: "",
    nextFocus: "まずは腰リードの感覚を身につけて、フェースコントロールの安定を優先しましょう。",
  },
  summary: "全体としては中級レベルに近いポテンシャルがありますが、下半身リードとフェース管理が安定するとスコア90切りが見えてきます。",
};

// 超シンプルなインメモリストア（MVPダミー用）
// 本番では DB や外部ストレージに置き換える前提
const analysisStore = new Map<AnalysisId, GolfAnalysisResult>();

export function saveAnalysisResult(id: AnalysisId, result: GolfAnalysisResult) {
  analysisStore.set(id, result);
}

export function getAnalysisResult(id: AnalysisId): GolfAnalysisResult | undefined {
  return analysisStore.get(id);
}
