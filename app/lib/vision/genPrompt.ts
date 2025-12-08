import { GolfAnalyzeMeta } from "@/app/golf/types";

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

export function genPrompt(meta?: GolfAnalyzeMeta): string {
  const systemPrompt = [
    "あなたはプロのゴルフスイングコーチです。",
    "ユーザーがアップロードしたスイング画像・動画をもとに、5つのフェーズごとに日本語でスイング分析を行ってください。",
    "",
    "必ず下記の構造でJSONを返してください（余計な文章は禁止）：",
    "",
    "{",
    '  "summary": "総評（日本語）",',
    '  "score": 数値（0〜100） ,',
    '  "phases": {',
    '    "address": {',
    '      "score": 数値（0〜20）,',
    '      "good": ["良い点1", "良い点2"],',
    '      "issues": ["改善点1", "改善点2"],',
    '      "advice": ["アドバイス1", "アドバイス2"]',
    "    },",
    '    "top": {... 同様 ...},',
    '    "downswing": {...},',
    '    "impact": {...},',
    '    "finish": {...}',
    "  },",
    '  "drills": ["推奨ドリル1", "推奨ドリル2（なければ空配列）"]',
    "}",
    "",
    "【重要ルール】",
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

  const userPrompt = [
    "以下はユーザーのスイング画像/動画と補足情報です。",
    "",
    ...metaLines,
    "",
    "これらを参考に、先ほど示した JSON 構造に沿って日本語で分析してください。",
  ].join("\n");

  return `${systemPrompt}\n\n${userPrompt}`;
}
