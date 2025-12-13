// app/api/golf/causal-explanation/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { CausalImpactExplanation, GolfAnalyzeMeta, SwingAnalysis } from "@/app/golf/types";

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

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function parseObEstimate(ob?: string | number | null): number | undefined {
  if (typeof ob === "number" && Number.isFinite(ob)) return ob;
  if (typeof ob === "string") {
    const m = ob.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function pickWorstIssue(phases?: SwingAnalysis["phases"], summary?: string): { issue: string; relatedMiss: string } {
  if (phases) {
    const entries = Object.entries(phases) as Array<[keyof typeof phases, (typeof phases)[keyof typeof phases]]>;
    const sorted = entries.sort((a, b) => (a[1]?.score ?? 99) - (b[1]?.score ?? 99));
    for (const [, phase] of sorted) {
      const candidate = phase?.issues?.[0];
      if (candidate) {
        const relatedMiss =
          candidate.includes("フェース") || candidate.includes("開き")
            ? "フェース管理が不安定"
            : candidate.includes("体重") || candidate.includes("重心")
              ? "軌道とコンタクトがぶれる"
              : candidate.includes("リリース") || candidate.includes("リスト") || candidate.includes("手首")
                ? "リリースが早まりトップやダフリが出る"
                : "打点と方向性が乱れやすい";
        return { issue: candidate, relatedMiss };
      }
    }
  }

  const fallbackIssue = summary?.split("\n")?.[0]?.trim() || "スイングの再現性が不足";
  return {
    issue: fallbackIssue,
    relatedMiss: "打点と方向性が乱れやすい",
  };
}

function buildFallback(payload: CausalRequestPayload): CausalImpactExplanation {
  const totalScoreRaw = payload.totalScore ?? payload.result?.totalScore ?? 0;
  const totalScore = clamp(Number.isFinite(totalScoreRaw) ? Number(totalScoreRaw) : 0, 0, 100);
  const phases = payload.phases ?? payload.result?.phases;
  const summary = payload.summary ?? payload.result?.summary;
  const { issue, relatedMiss } = pickWorstIssue(phases, summary);
  const obFromEstimate = parseObEstimate(payload.roundEstimates?.ob);
  const obDelta = obFromEstimate ?? clamp(3.2 - totalScore * 0.012, 0.6, 4.5);
  const scoreDelta = Math.max(1, Math.round(obDelta * 2.3 + (100 - totalScore) * 0.015));

  return {
    issue,
    relatedMiss,
    scoreImpact: {
      obDelta: Number.isFinite(obDelta) ? Number(obDelta.toFixed(1)) : undefined,
      scoreDelta,
    },
    source: "fallback",
    note: "ルールベースの推定（数値は推定値）",
  };
}

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
  const obDeltaRaw = typeof impact.obDelta === "number" ? impact.obDelta : parseObEstimate(impact.obDelta as any);
  const obDelta = Number.isFinite(obDeltaRaw) ? Number((obDeltaRaw as number).toFixed(1)) : fallback.scoreImpact.obDelta;
  const scoreDeltaCandidate = typeof impact.scoreDelta === "number" ? impact.scoreDelta : fallback.scoreImpact.scoreDelta;
  const scoreDelta = Number.isFinite(scoreDeltaCandidate)
    ? Math.max(1, Math.round(scoreDeltaCandidate as number))
    : fallback.scoreImpact.scoreDelta;

  const note = typeof obj.note === "string" && obj.note.trim().length > 0 ? obj.note.trim() : fallback.note;

  return {
    issue,
    relatedMiss,
    scoreImpact: { obDelta, scoreDelta },
    source: "ai",
    note,
  };
}

export async function POST(req: Request) {
  try {
    const payload = (await req.json().catch(() => ({}))) as CausalRequestPayload;
    const fallback = buildFallback(payload);

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
      { causalImpact: buildFallback({}), note: "AI generation failed; fallback used" },
      { status: 200 }
    );
  }
}
