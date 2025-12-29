// app/api/golf/round-estimate/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { computeRoundFallbackFromScore } from "@/app/golf/utils/scoreCalibration";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type RoundEstimate = {
  strokeRange: string;
  fwKeep: string;
  gir: string;
  ob: string;
  source?: "ai" | "fallback";
  note?: string;
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function computeFallback(totalScore: number): RoundEstimate {
  const score = clamp(Number.isFinite(totalScore) ? totalScore : 0, 0, 100);
  const fallback = computeRoundFallbackFromScore(score);

  return {
    strokeRange: fallback.strokeRange,
    fwKeep: fallback.fwKeep,
    gir: fallback.gir,
    ob: fallback.ob,
    source: "fallback",
  };
}

function buildPrompt(params: { totalScore: number; phases?: unknown; meta?: unknown; fallback: RoundEstimate }) {
  const { totalScore, phases, meta, fallback } = params;
  const phasesText = phases ? JSON.stringify(phases).slice(0, 1500) : "N/A";
  const metaText = meta ? JSON.stringify(meta).slice(0, 500) : "N/A";

  return `
You are a golf coach estimating an 18-hole round score range from a swing assessment.

Input:
- total swing score (0-100): ${totalScore}
- phase scores/comments (JSON): ${phasesText}
- meta (handedness, club, level, etc.): ${metaText}

Guidelines:
- Output should be conservative and realistic for amateurs.
- Rough anchors: swing score ~70 => around 90s, ~83 => around 75-85, ~95 => around high-60s/low-70s.
- Return conservative but realistic metrics for FW keep %, GIR %, and OB count (18H equivalent).
- Keep numbers human-readable integers; OB can be one decimal.
- Output ONLY JSON with keys: strokeRange (string like "84〜88"), fwKeep (string "%"), gir (string "%"), ob (string "x.x 回"), source ("ai").
- If uncertain, stay within these guardrails: strokeRange around ${fallback.strokeRange}, fwKeep around ${fallback.fwKeep}, gir around ${fallback.gir}, ob around ${fallback.ob}.

Respond with JSON only.`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const totalScoreRaw = body?.totalScore;
    const totalScore = Number(totalScoreRaw);

    if (!Number.isFinite(totalScore)) {
      return NextResponse.json({ error: "totalScore is required" }, { status: 400 });
    }

    const fallback = computeFallback(totalScore);

    if (!client.apiKey) {
      return NextResponse.json({ ...fallback, note: "OPENAI_API_KEY is missing" }, { status: 200 });
    }

    const prompt = buildPrompt({
      totalScore,
      phases: body?.phases,
      meta: body?.meta,
      fallback,
    });

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const parsed =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (completion as any).choices?.[0]?.message?.parsed ?? completion.choices?.[0]?.message?.content;

    let json: Partial<RoundEstimate> = {};
    if (parsed) {
      try {
        json = typeof parsed === "string" ? (JSON.parse(parsed) as Partial<RoundEstimate>) : (parsed as Partial<RoundEstimate>);
      } catch {
        json = {};
      }
    }

    const result: RoundEstimate = {
      strokeRange: json.strokeRange || fallback.strokeRange,
      fwKeep: json.fwKeep || fallback.fwKeep,
      gir: json.gir || fallback.gir,
      ob: json.ob || fallback.ob,
      source: "ai",
      note: json.note,
    };

    return NextResponse.json(result, { status: 200 });
  } catch (err: unknown) {
    console.error("[round-estimate]", err);
    const totalScore = (err && typeof err === "object" && "totalScore" in err && Number.isFinite(err.totalScore))
      ? Number(err.totalScore)
      : 0;
    const fallback = computeFallback(totalScore);
    return NextResponse.json(
      { ...fallback, note: "AI estimation failed; using fallback" },
      { status: 200 }
    );
  }
}
