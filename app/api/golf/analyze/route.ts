// app/api/golf/analyze/route.ts

import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { AnalysisId, GolfAnalyzeMeta, GolfAnalysisRecord, SwingAnalysis } from "@/app/golf/types";
import { askVisionAPI } from "@/app/lib/vision/askVisionAPI";
import { extractPhaseFrames, PhaseKey } from "@/app/lib/vision/extractPhaseFrames";
import { genPrompt } from "@/app/lib/vision/genPrompt";
import { parseMultiPhaseResponse } from "@/app/lib/vision/parseMultiPhaseResponse";
import { saveAnalysis } from "@/app/lib/store";

// Node.js ランタイムで動かしたい場合は明示（必須ではないが念のため）
export const runtime = "nodejs";

const phaseOrder: PhaseKey[] = ["address", "top", "downswing", "impact", "finish"];

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const file = formData.get("file");
    const handedness = formData.get("handedness");
    const clubType = formData.get("clubType");
    const level = formData.get("level");
    const previousAnalysisId = formData.get("previousAnalysisId");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    if (typeof handedness !== "string" || typeof clubType !== "string" || typeof level !== "string") {
      return NextResponse.json({ error: "handedness, clubType, level are required" }, { status: 400 });
    }

    const meta: GolfAnalyzeMeta = {
      handedness: handedness as GolfAnalyzeMeta["handedness"],
      clubType: clubType as GolfAnalyzeMeta["clubType"],
      level: level as GolfAnalyzeMeta["level"],
      previousAnalysisId: typeof previousAnalysisId === "string" ? (previousAnalysisId as AnalysisId) : null,
    };

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";

    const frames = await extractPhaseFrames({ buffer, mimeType });
    const prompt = genPrompt(meta);

    const orderedFrames = phaseOrder.map((phase) => frames[phase]);
    const jsonText = await askVisionAPI({ frames: orderedFrames, prompt });
    const parsed = parseMultiPhaseResponse(jsonText);

    const totalScore = Number.isFinite(parsed.totalScore)
      ? parsed.totalScore
      : phaseOrder.reduce((sum, phase) => sum + parsed.phases[phase].score, 0);

    const analysisId: AnalysisId =
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `golf-${Date.now()}`;

    const timestamp = Date.now();
    const result: SwingAnalysis = {
      analysisId,
      createdAt: new Date(timestamp).toISOString(),
      totalScore,
      phases: parsed.phases,
      summary: parsed.summary,
      recommendedDrills: parsed.recommendedDrills ?? [],
    };

    const record: GolfAnalysisRecord = {
      id: analysisId,
      result,
      meta,
      createdAt: timestamp,
    };

    saveAnalysis(record);

    return NextResponse.json({
      analysisId,
    });
  } catch (error) {
    console.error("[golf/analyze] error:", error);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
