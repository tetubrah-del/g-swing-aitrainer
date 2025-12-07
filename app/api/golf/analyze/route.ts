// app/api/golf/analyze/route.ts

import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import {
  AnalysisId,
  GolfAnalyzeMeta,
  GolfAnalysisRecord,
  GolfAnalysisResult,
  saveAnalysisResult,
} from "@/app/golf/types";
import { createVisionJsonResponse } from "@/app/lib/openai";

// Node.js ランタイムで動かしたい場合は明示（必須ではないが念のため）
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const file = formData.get("file");
    const handedness = formData.get("handedness");
    const clubType = formData.get("clubType");
    const level = formData.get("level");
    const previousAnalysisId = formData.get("previousAnalysisId");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "file is required" },
        { status: 400 }
      );
    }

    if (
      typeof handedness !== "string" ||
      typeof clubType !== "string" ||
      typeof level !== "string"
    ) {
      return NextResponse.json(
        { error: "handedness, clubType, level are required" },
        { status: 400 }
      );
    }

    const meta: GolfAnalyzeMeta = {
      handedness: handedness as GolfAnalyzeMeta["handedness"],
      clubType: clubType as GolfAnalyzeMeta["clubType"],
      level: level as GolfAnalyzeMeta["level"],
      previousAnalysisId:
        typeof previousAnalysisId === "string" ? (previousAnalysisId as AnalysisId) : null,
    };

    const buffer = Buffer.from(await file.arrayBuffer());
    const base64Image = buffer.toString("base64");
    const mimeType = file.type || "application/octet-stream";

    const prompt = [
      "You are a professional Japanese golf swing coach. Analyze the provided swing image or video frame and respond ONLY with JSON that matches the following TypeScript type (no prose or commentary):",
      JSON.stringify(
        {
          score: 85,
          estimatedOnCourseScore: "90〜100",
          estimatedLevel: "中級寄りの初級",
          goodPoints: ["..."],
          badPoints: ["..."],
          priorityFix: ["..."],
          drills: ["..."],
          improvement: {
            hasPrevious: Boolean(meta.previousAnalysisId),
            direction: "改善している/悪化している/変わらない などの短文",
            changeSummary: "前回との変化（ない場合は簡潔に理由を記載）",
            nextFocus: "次に意識するポイント",
          },
          summary: "総評の短文",
        },
        null,
        2
      ),
      "Requirements:",
      "- score should be an integer between 0 and 100.",
      "- Keep bullet items concise in Japanese (<= 60 characters when possible).",
      `- If information is uncertain, make a best-effort estimate based on the visual cues and the following meta data: handedness=${meta.handedness}, clubType=${meta.clubType}, level=${meta.level}.`,
    ].join("\n");

    const visionResponse = await createVisionJsonResponse({
      prompt,
      base64Image,
      mimeType,
    });

    let parsed: GolfAnalysisResult;
    try {
      parsed = JSON.parse(visionResponse.outputText) as GolfAnalysisResult;
    } catch (parseError) {
      console.error(
        "[golf/analyze] failed to parse JSON:",
        parseError,
        visionResponse.outputText
      );
      throw new Error("Failed to parse JSON from Vision API response");
    }

    const analysisId: AnalysisId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `golf-${Date.now()}`;

    const record: GolfAnalysisRecord = {
      id: analysisId,
      result: parsed,
      meta,
      createdAt: Date.now(),
    };

    saveAnalysisResult(record);

    return NextResponse.json({
      analysisId,
      result: parsed,
      meta,
      createdAt: record.createdAt,
    });
  } catch (error) {
    console.error("[golf/analyze] error:", error);
    const message = error instanceof Error ? error.message : "internal server error";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
