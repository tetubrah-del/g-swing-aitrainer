// app/api/golf/causal-explanation/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { CausalImpactExplanation, GolfAnalyzeMeta, SwingAnalysis } from "@/app/golf/types";
import { buildRuleBasedCausalImpact } from "@/app/golf/utils/causalImpact";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type CausalRequestPayload = {
  analysisId?: string;
  totalScore?: number;
  phases?: SwingAnalysis["phases"];
  summary?: string;
  meta?: GolfAnalyzeMeta | null;
  roundEstimates?: {
    strokeRange?: string;
    ob?: string | number;
  };
  // fallback: result を丸ごと送ってきた場合も拾えるように
  result?: Pick<SwingAnalysis, "totalScore" | "phases" | "summary">;
};

function buildPrompt(params: { payload: CausalRequestPayload; fallback: CausalImpactExplanation }) {
  const { payload, fallback } = params;
  const totalScore = payload.totalScore ?? payload.result?.totalScore ?? 0;
  const phasesText = payload.phases ?? payload.result?.phases;
  const summary = payload.summary ?? payload.result?.summary ?? "";
  const meta = payload.meta;
  const roundEstimates = payload.roundEstimates;

  const trimmedPhases = phasesText ? JSON.stringify(phasesText).slice(0, 1800) : "N/A";
  const trimmedSummary = summary.slice(0, 400);
  const roundText = JSON.stringify(roundEstimates ?? {}).slice(0, 400);

  return `
以下はゴルフスイング診断データです。
この中から「スコアへの影響が最大の問題」を1つ選び、以下の形式で因果関係を説明してください。

形式：
問題 → 起こるミス → スコア影響（打数）

制約：
・必ず1つに絞る
・数値は推定でよい
・日本語で簡潔に
・「複数ある問題の中から、最もスコアに影響が大きい1つだけを選び、因果関係を簡潔に説明せよ」

入力データ:
- totalScore (0-100): ${totalScore}
- phases (JSON): ${trimmedPhases}
- summary: ${trimmedSummary}
- meta: ${meta ? JSON.stringify(meta).slice(0, 400) : "N/A"}
- round estimates: ${roundText}
- fallback suggestion (参考にして良い): ${JSON.stringify(fallback)}

必ず以下のJSON構造のみで返してください:
{
  "issue": "問題点（日本語）",
  "relatedMiss": "起こりやすいミス（日本語）",
  "scoreImpact": {
    "obDelta": 2.2,
    "scoreDelta": 5
  },
  "chain": ["問題点", "ミス", "OB +2.2回（18H換算）", "推定スコア +5打"],
  "confidence": "high | medium | low",
  "nextAction": { "title": "次の練習で意識", "content": "1つだけ提示" },
  "note": "数値は推定であることを明示"
}
`;
}

function normalizeFromAi(candidate: unknown, fallback: CausalImpactExplanation): CausalImpactExplanation {
  if (!candidate || typeof candidate !== "object") return fallback;
  const obj = candidate as Record<string, unknown>;
  const issue = typeof obj.issue === "string" && obj.issue.trim().length > 0 ? obj.issue.trim() : fallback.issue;
  const relatedMiss =
    typeof obj.relatedMiss === "string" && obj.relatedMiss.trim().length > 0
      ? obj.relatedMiss.trim()
      : fallback.relatedMiss;

  const impact = (obj.scoreImpact ?? {}) as Record<string, unknown>;
  const obDeltaRaw = typeof impact.obDelta === "number" ? impact.obDelta : fallback.scoreImpact.obDelta;
  const obDelta = Number.isFinite(obDeltaRaw) ? Number((obDeltaRaw as number).toFixed(1)) : fallback.scoreImpact.obDelta;
  const scoreDeltaCandidate = typeof impact.scoreDelta === "number" ? impact.scoreDelta : fallback.scoreImpact.scoreDelta;
  const scoreDelta = Number.isFinite(scoreDeltaCandidate)
    ? Math.max(1, Math.round(scoreDeltaCandidate as number))
    : fallback.scoreImpact.scoreDelta;

  const note = typeof obj.note === "string" && obj.note.trim().length > 0 ? obj.note.trim() : fallback.note;
  const chain = Array.isArray(obj.chain) ? (obj.chain.filter((c) => typeof c === "string") as string[]) : fallback.chain;
  const confidence =
    obj.confidence === "high" || obj.confidence === "medium" || obj.confidence === "low"
      ? obj.confidence
      : fallback.confidence;
  const nextActionRaw = obj.nextAction as Record<string, unknown> | undefined;
  const nextAction =
    nextActionRaw && typeof nextActionRaw === "object" && typeof nextActionRaw.content === "string"
      ? {
          title: typeof nextActionRaw.title === "string" ? nextActionRaw.title : fallback.nextAction?.title ?? "次の練習で意識",
          content: nextActionRaw.content,
        }
      : fallback.nextAction;

  return {
    issue,
    primaryIssue: issue,
    relatedMiss,
    scoreImpact: { obDelta, scoreDelta },
    chain,
    nextAction,
    confidence,
    source: "ai",
    note,
  };
}

export async function POST(req: Request) {
  try {
    const payload = (await req.json().catch(() => ({}))) as CausalRequestPayload;
    const fallback = buildRuleBasedCausalImpact({
      result: payload.result as SwingAnalysis | undefined,
      phases: payload.phases,
      totalScore: payload.totalScore,
      summary: payload.summary,
      roundEstimates: payload.roundEstimates,
      meta: payload.meta,
    });

    if (!client.apiKey) {
      return NextResponse.json(
        { analysisId: payload.analysisId, causalImpact: fallback, note: "OPENAI_API_KEY is missing" },
        { status: 200 }
      );
    }

    const prompt = buildPrompt({ payload, fallback });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a golf coach who explains causal impact of swing flaws on score." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
      temperature: 0.2,
    });

    const parsed =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (completion as any).choices?.[0]?.message?.parsed ?? completion.choices?.[0]?.message?.content;

    let candidate: unknown = {};
    if (parsed) {
      try {
        candidate = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
      } catch {
        candidate = parsed;
      }
    }

    const causalImpact = normalizeFromAi(candidate, fallback);

    return NextResponse.json({ analysisId: payload.analysisId, causalImpact }, { status: 200 });
  } catch (err: unknown) {
    console.error("[causal-explanation]", err);
    return NextResponse.json(
      { causalImpact: buildRuleBasedCausalImpact({}), note: "AI generation failed; fallback used" },
      { status: 200 }
    );
  }
}
