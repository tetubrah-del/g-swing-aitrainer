import { GolfAnalyzeMeta, SwingAnalysis } from "@/app/golf/types";
import { retrieveCoachKnowledge } from "@/app/coach/rag/retrieve";

function toJapaneseHandedness(handedness: GolfAnalyzeMeta["handedness"]): string {
  return handedness === "left" ? "左打ち" : "右打ち";
}

function toJapaneseClub(club: GolfAnalyzeMeta["clubType"]): string {
  switch (club) {
    case "driver":
      return "ドライバー";
    case "iron":
      return "アイアン";
    case "wedge":
      return "ウェッジ";
    default:
      return club;
  }
}

function toJapaneseLevel(level: GolfAnalyzeMeta["level"]): string {
  switch (level) {
    case "beginner":
      return "ビギナー";
    case "beginner_plus":
      return "初級プラス";
    case "intermediate":
      return "中級";
    case "upper_intermediate":
      return "上級手前";
    case "advanced":
      return "上級";
    default:
      return level;
  }
}

export function genPrompt(
  meta?: GolfAnalyzeMeta,
  previousReport?: SwingAnalysis | null,
  analyzerBlock?: string | null
): string {
  const principlesQuery = [
    "診断思考フロー",
    "因果",
    "優先度",
    "上流",
    "結果は修正しない",
    "インパクトゾーン",
    "リリース",
    "タメ",
    "フェース管理",
    "ハンドファースト",
  ].join(" ");
  const scoringQuery = [
    "フェーズ別診断",
    "0〜20点",
    "次フェーズへの影響度",
    "点数帯",
    "ハードペナルティ",
    "中上級",
    "上限",
    "Address",
    "Backswing",
    "Top",
    "Downswing",
    "Impact",
    "Finish",
    "早期伸展",
    "骨盤が前に出る",
    "腰が前に出る",
    "前傾が起きる",
    "腰の突っ込み",
    "スペースが潰れる",
    "アウトサイドイン",
    "カット軌道",
    "外から下りる",
    "外から入る",
    "上から入る",
    "かぶせ",
  ].join(" ");

  const principles = retrieveCoachKnowledge(principlesQuery, { maxChunks: 3, maxChars: 1100, minScore: 1 });
  // Scoring docs are long; allow slightly weaker chunk scores so they still show up.
  const scoring = retrieveCoachKnowledge(scoringQuery, { maxChunks: 5, maxChars: 1700, minScore: 0 });

  const ragBlocks: string[] = [];
  if (principles.contextText) {
    ragBlocks.push(
      [
        "【CoachingPrinciples（RAG）】",
        principles.contextText,
        "",
        "上の原則に従い、観測→因果→最上流の1点→ドリル（1つ）という順序で、結果（形）を直す指導は避けること。",
      ].join("\n")
    );
  }
  if (scoring.contextText) {
    ragBlocks.push(
      [
        "【PhaseScoringRubric（RAG）】",
        scoring.contextText,
        "",
        "上の採点ルーブリックに従い、各フェーズを0〜20点で絶対評価し、破綻やハードペナルティは強く減点すること。",
      ].join("\n")
    );
  }
  const ragSection = ragBlocks.length ? `${ragBlocks.join("\n\n")}\n\n` : "";

  const systemPrompt = [
    "あなたはプロのゴルフスイングコーチです。",
    "ユーザーがアップロードしたスイング画像・動画をもとに、6つのフェーズごとに日本語でスイング分析を行ってください。",
    "さらに、連続する14〜16枚のフレームを使ってステージ遷移（Address→Finish）の診断も行ってください。",
    "",
    "必ず下記の構造でJSONを返してください（余計な文章は禁止）：",
    "",
    "{",
    '  "summary": "総評（日本語）",',
    '  "analyzer_comment": "スイングアナライザーAIコーチ解説（日本語）",',
    '  "score": 数値（0〜100） ,',
    '  "on_plane": {',
    '    "score": 数値（0〜100）,',
    '    "summary": "1文サマリ（cm/deg/度などの単位や数値の記載は禁止）",',
    '    "top_to_downswing_cm": 数値（cm, 小数OK, 符号あり）,',
    '    "late_downswing_cm": 数値（cm, 小数OK, 符号あり）,',
    '    "impact_cm": 数値（cm, 小数OK, 符号あり）,',
    '    "backswing_plane": { "x1": 0〜1, "y1": 0〜1, "x2": 0〜1, "y2": 0〜1 },',
    '    "downswing_plane": { "x1": 0〜1, "y1": 0〜1, "x2": 0〜1, "y2": 0〜1 }',
    "  },",
    '  "phases": {',
    '    "address": {',
    '      "score": 数値（0〜20）,',
    '      "good": ["良い点1", "良い点2"],',
    '      "issues": ["改善点1", "改善点2"],',
    '      "advice": ["アドバイス1", "アドバイス2"]',
    "    },",
    '    "backswing": {... 同様 ...},',
    '    "top": {... 同様 ...},',
    '    "downswing": {...},',
    '    "impact": {...},',
    '    "finish": {...}',
    "  },",
    '  "major_ng": {',
    '    "address": true/false,',
    '    "backswing": true/false,',
    '    "top": true/false,',
    '    "downswing": true/false,',
    '    "impact": true/false,',
    '    "finish": true/false',
    "  },",
    '  "mid_high_ok": {',
    '    "address": true/false,',
    '    "backswing": true/false,',
    '    "top": true/false,',
    '    "downswing": true/false,',
    '    "impact": true/false,',
    '    "finish": true/false',
    "  },",
    '  "drills": ["推奨ドリル1", "推奨ドリル2（なければ空配列）"],',
    '  "sequence": {',
    '    "stages": [',
    '      { "stage": "address", "headline": "アドレスの評価", "details": ["1-2文の指摘"], "keyFrameIndices": [0,1] },',
    '      { "stage": "address_to_backswing", "headline": "テークバック開始の評価", "details": ["1-2文の指摘"], "keyFrameIndices": [2,3] },',
    '      { "stage": "backswing_to_top", "headline": "トップへの入り方", "details": ["1-2文の指摘"], "keyFrameIndices": [4,5] },',
    '      { "stage": "top_to_downswing", "headline": "切り返し", "details": ["1-2文の指摘"], "keyFrameIndices": [7,8] },',
    '      { "stage": "downswing_to_impact", "headline": "インパクトゾーン", "details": ["1-2文の指摘"], "keyFrameIndices": [10,11] },',
    '      { "stage": "finish", "headline": "フィニッシュ", "details": ["1-2文の指摘"], "keyFrameIndices": [13,14] }',
    "    ]",
    "  },",
    '  "comparison": {',
    '    "improved": ["改善した点1"],',
    '    "regressed": ["悪化した点1"]',
    "  }",
    "}",
    "",
    "summary:",
    "- 日本語で 4〜5 文",
    "- 落ち着いた指導系の語り口で、読み物として成立させる",
    "- 構成は「結論→情緒（納得感）→改善1つ」で固定",
    "- 2〜3回に1回の頻度で比喩を入れる（過剰に煽らない）",
    "- フェーズ全体を俯瞰した技術的考察と、改善の方向性を含める",
    "",
    "analyzer_comment:",
    "- スイングアナライザー定量の内容を根拠に 4〜5 文",
    "- 落ち着いた指導系の語り口で、読み物として成立させる",
    "- 構成は「結論→情緒（納得感）→改善1つ」で固定",
    "- 2〜3回に1回の頻度で比喩を入れる（過剰に煽らない）",
    "- 量的な傾向（外側率/回転量/ブレ等）を言葉で説明し、定量と矛盾しない",
    "- スイングアナライザー定量が無い場合は空文字（\"\"）で返す",
    "",
    "previousReport:",
    "- 前回の JSON（summary, scores, phases）を渡された場合は、",
    "  「前回と比べて改善した点／悪化した点」を 3〜5 個の bullet で返すこと。",
    "- comparison セクションは任意だが JSON 内に以下形式で追加する：",
    '',
    '"comparison": {',
    '  "improved": ["改善した点1", ...],',
    '  "regressed": ["悪化した点1", ...]',
    "}",
    "",
    "【重要ルール】",
    "- スイングアナライザー定量は結論の根拠として扱い、矛盾する評価は書かない。",
    "- スコア（score）は今回のフレームの内容からの「絶対評価」にすること（previousReport に引っ張られて上下させない）。",
    "- score は 6フェーズの各 score（0〜20）の合計を 120点満点として 100点満点に換算した値にすること：round((sumPhaseScore/120)*100)。",
    "- major_ng / mid_high_ok は各フェーズのキー6つを必ず含め、値は必ず boolean で返すこと（省略禁止）。",
    "- 特に Downswing は必ず「クラブ軌道（アウトサイドイン/インサイドアウト）」「外から下りる（カット軌道）」「上半身先行/早開き」を判定し、以下を守ること：",
    "  - 明確に外側から入っている場合は、issues に必ず「アウトサイドイン傾向が強い」を含め、major_ng.downswing = true かつ phases.downswing.score <= 8 にする",
    "  - 断定できないが外側寄りなら、issues に必ず「アウトサイドイン傾向が見られる」を含め、mid_high_ok.downswing = false かつ phases.downswing.score は 9〜12 にする",
    "- 特に Impact は必ず「早期伸展（骨盤が前に出る／前傾が起きる／スペースが潰れる）」を判定し、該当するなら以下を同時に満たすこと：",
    '  - phases.impact.issues に必ず「早期伸展」または「骨盤が前に出る」または「前傾が起きる」を含める',
    "  - mid_high_ok.impact = false",
    "  - phases.impact.score <= 12（明確なら <= 10）",
    "- mid_high_ok.{phase} が false のフェーズは、そのフェーズの score を 10 以下にする（中上級条件未達のまま高得点を付けない）。",
    "- 画像は時系列で与えられる。stage は必ず以下の順序とキー名を使う：",
    "  address → address_to_backswing → backswing_to_top → top_to_downswing → downswing_to_impact → finish",
    "- keyFrameIndices が渡されたフレーム順序に基づくことを忘れない（不明なら空配列可）",
    "- on_plane は、Top→Downswing→Impact の画像から「プレーンに対して外側(+)/内側(-)」のズレを推定する。正確さより理解優先の粗い推定でOK。",
    "- good/issues/advice は落ち着いた指導系で簡潔に。advice は改善1つに絞る。",
    "- すべて日本語で書くこと",
    "- 日本のゴルフレッスンで一般的な用語を使うこと",
    "- 難しすぎる表現は避ける",
    "- JSON 以外の文章を返さない",
  ].join("\n");

  const metaLines = meta
    ? [
        "【補足情報】",
        `利き手：${toJapaneseHandedness(meta.handedness)}`,
        `クラブ：${toJapaneseClub(meta.clubType)}`,
        `レベル：${toJapaneseLevel(meta.level)}`,
      ]
    : ["【補足情報】なし"];

  const analyzerLines = analyzerBlock
    ? ["【スイングアナライザー定量】", analyzerBlock, ""]
    : ["【スイングアナライザー定量】なし", ""];

  const userPrompt = [
    "以下はユーザーのスイング画像/動画と補足情報です。",
    "",
    ...metaLines,
    "",
    ...analyzerLines,
    "",
    "これらを参考に、先ほど示した JSON 構造に沿って日本語で分析してください。",
    "詳細な総評を必ず含めること。",
  ];

  if (previousReport) {
    userPrompt.push("", "【前回の診断結果（比較用）】", JSON.stringify(previousReport, null, 2));
  }

  return `${systemPrompt}\n\n${ragSection}${userPrompt.join("\n")}`;
}
