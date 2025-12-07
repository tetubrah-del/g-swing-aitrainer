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
import { extractFrames } from "@/app/lib/vision/extractFrames";
import { parseVisionResponse, RawSwingMetrics } from "@/app/lib/vision/parseVisionResponse";

// Node.js ランタイムで動かしたい場合は明示（必須ではないが念のため）
export const runtime = "nodejs";

function calculateScore(metrics: RawSwingMetrics): number {
  let score = 100 - Math.abs(metrics.club_path) * 2 - Math.abs(metrics.impact_face_angle) * 3;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return score;
}

function estimateOnCourseScore(score: number): string {
  if (score >= 90) return "70〜80";
  if (score >= 80) return "80〜90";
  if (score >= 65) return "90〜100";
  return "100以上";
}

function estimateLevel(score: number): string {
  if (score >= 90) return "上級に近い中級";
  if (score >= 80) return "中級";
  if (score >= 65) return "初級〜中級";
  return "初級";
}

function buildGoodPoints(metrics: RawSwingMetrics): string[] {
  const points: string[] = [];

  if (Math.abs(metrics.club_path) <= 3) {
    points.push("クラブパスがニュートラルに近く、方向性が安定しています。");
  }

  if (Math.abs(metrics.impact_face_angle) <= 2) {
    points.push("インパクト時のフェース角が安定しており、ミスの幅が小さいです。");
  }

  if (metrics.tempo_ratio >= 2 && metrics.tempo_ratio <= 3.2) {
    points.push("テークバックとダウンスイングのリズムバランスが自然です。");
  }

  if (!points.length) {
    points.push("全体的なフォームに一定の再現性があります。");
  }

  return points;
}

function buildAnalysisResult(metrics: RawSwingMetrics, score: number, meta: GolfAnalyzeMeta): GolfAnalysisResult {
  const badPoints = metrics.issues.length
    ? metrics.issues
    : ["大きな欠点は少ないですが、フェース管理と体の回転を継続して確認しましょう。"]; 
  const priorityFix = badPoints.length ? badPoints.slice(0, 2) : ["スイングの再現性を高めるための基礎練習を継続しましょう。"]; 
  const drills = metrics.advice.length
    ? metrics.advice
    : ["素振りでリズムと体の回転を確認するドリルを毎日行ってください。"]; 

  const summary = `総合スコア${score}点。クラブパス${metrics.club_path.toFixed(1)}°、フェース角${metrics.impact_face_angle.toFixed(
    1
  )}°、テンポ比${metrics.tempo_ratio.toFixed(2)}。主な改善点: ${badPoints[0]}`;

  return {
    score,
    estimatedOnCourseScore: estimateOnCourseScore(score),
    estimatedLevel: estimateLevel(score),
    goodPoints: buildGoodPoints(metrics),
    badPoints,
    priorityFix,
    drills,
    improvement: {
      hasPrevious: Boolean(meta.previousAnalysisId),
      direction: meta.previousAnalysisId ? "前回比較データは未保存" : "初回診断のため比較なし",
      changeSummary: meta.previousAnalysisId
        ? "前回データがないため比較できませんでした。"
        : "初回診断のため比較データはありません。",
      nextFocus: drills[0] ?? "スイングのリズムとフェース管理を継続して確認しましょう。",
    },
    summary,
    metrics,
    issues: metrics.issues,
    advice: metrics.advice,
  };
}

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

    const frames = await extractFrames({ buffer, mimeType, maxFrames: 6 });
    if (!frames.length) {
      throw new Error("No frames extracted from input");
    }

    const jsonText = await askVisionAPI({ frames, meta });
    const metrics = parseVisionResponse(jsonText);
    const score = calculateScore(metrics);

    const analysisId: AnalysisId =
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `golf-${Date.now()}`;

    const record: GolfAnalysisRecord = {
      id: analysisId,
      result: buildAnalysisResult(metrics, score, meta),
      meta,
      createdAt: Date.now(),
    };

    saveAnalysisResult(record);

    return NextResponse.json({
      analysisId,
    });
  } catch (error) {
    console.error("[golf/analyze] error:", error);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
