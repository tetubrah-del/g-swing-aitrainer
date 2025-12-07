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
import { askVisionAPI } from "@/app/lib/vision/askVisionAPI";
import { parseVisionResponse } from "@/app/lib/vision/parseVisionResponse";

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
      "You are a professional Japanese golf swing coach.",
      "Analyze the provided swing image or video frame and return ONLY strict JSON matching the schema without any explanation or code fences.",
      "Fields must be concise and based solely on the visual cues.",
      `Player info: handedness=${meta.handedness}, clubType=${meta.clubType}, level=${meta.level}.`,
    ].join("\n");

    const visionText = await askVisionAPI({
      prompt,
      base64Image,
      mimeType,
    });

    const visionResult = parseVisionResponse(visionText);

    const score = Math.max(
      0,
      Math.min(
        100,
        100 - Math.abs(visionResult.club_path) * 2 - Math.abs(visionResult.impact_face_angle) * 3
      )
    );

    const parsed = {
      metrics: {
        impact_face_angle: visionResult.impact_face_angle,
        club_path: visionResult.club_path,
        body_open_angle: visionResult.body_open_angle,
        hand_height: visionResult.hand_height,
        tempo_ratio: visionResult.tempo_ratio,
      },
      score,
      issues: visionResult.issues,
      advice: visionResult.advice,
      createdAt: new Date().toISOString(),
    } as unknown as GolfAnalysisResult;

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
