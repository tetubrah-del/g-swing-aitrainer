import { GolfAnalyzeMeta } from "@/app/golf/types";

export function genPrompt(meta?: GolfAnalyzeMeta): string {
  const metaLines = meta
    ? [`Player info: handedness=${meta.handedness}, clubType=${meta.clubType}, level=${meta.level}.`]
    : [];

  return [
    "You are an elite golf swing coach.",
    "Analyze the user's swing using the 5-phase model: address, top, downswing, impact, finish.",
    "Return JSON ONLY with exact structure:",
    "{",
    '  "address": { "score": number, "good": [..], "issues": [..], "advice": [..] },',
    '  "top":     { "score": number, "good": [..], "issues": [..], "advice": [..] },',
    '  "downswing": { "score": number, "good": [..], "issues": [..], "advice": [..] },',
    '  "impact": { "score": number, "good": [..], "issues": [..], "advice": [..] },',
    '  "finish": { "score": number, "good": [..], "issues": [..], "advice": [..] },',
    '  "totalScore": number,',
    '  "summary": "string"',
    "}",
    "Always include all 5 phases, even if frames are similar. Scores are 0-20 each, totalScore is 0-100.",
    ...metaLines,
  ].join("\n");
}
