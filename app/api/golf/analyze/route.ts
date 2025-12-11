// app/api/golf/analyze/route.ts

import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { AnalysisId, GolfAnalyzeMeta, GolfAnalysisRecord, SwingAnalysis } from "@/app/golf/types";
import { askVisionAPI } from "@/app/lib/vision/askVisionAPI";
import { extractPhaseFrames, PhaseFrame, PhaseKey, PhaseFrames } from "@/app/lib/vision/extractPhaseFrames";
import { genPrompt } from "@/app/lib/vision/genPrompt";
import { parseMultiPhaseResponse } from "@/app/lib/vision/parseMultiPhaseResponse";
import { getAnalysis, saveAnalysis } from "@/app/lib/store";

// Node.js ランタイムで動かしたい場合は明示（必須ではないが念のため）
export const runtime = "nodejs";

const phaseOrder: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];
const clientPhaseOrder: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];

function parseDataUrl(input: string | null): { base64Image: string; mimeType: string } | null {
  if (!input) return null;
  const match = input.match(/^data:(.*?);base64,(.*)$/);
  if (!match) {
    return { base64Image: input, mimeType: "image/jpeg" };
  }
  return { base64Image: match[2], mimeType: match[1] || "image/jpeg" };
}

function mergePhaseFrames(source: Partial<PhaseFrames> | null, fallback: PhaseFrames): PhaseFrames {
  return {
    address: source?.address ?? fallback.address,
    // 修正点：
    // 1. source.backswing（クライアント抽出）を最優先
    // 2. fallback.backswing（サーバー側バックアップ）
    // 3. source.address（極限時の代替）
    // 4. fallback.address（最終保険）
    backswing:
      source?.backswing ??
      fallback.backswing ??
      source?.address ??
      fallback.address,
    top: source?.top ?? fallback.top,
    downswing: source?.downswing ?? fallback.downswing,
    impact: source?.impact ?? fallback.impact,
    finish: source?.finish ?? fallback.finish,
  } satisfies PhaseFrames;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const file = formData.get("file");
    const handedness = formData.get("handedness");
    const clubType = formData.get("clubType");
    const level = formData.get("level");
    const previousAnalysisId = formData.get("previousAnalysisId");
    const previousReportJson = formData.get("previousReportJson");
    const phaseFramesJson = formData.get("phaseFramesJson");
    const inlinePhaseFrames = formData.getAll("phaseFrames[]");

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

    let providedFrames: Partial<PhaseFrames> | null = null;

    if (typeof phaseFramesJson === "string") {
      try {
        const parsed = JSON.parse(phaseFramesJson) as Array<
          Partial<PhaseFrame> & { phase?: PhaseKey; timestamp?: number }
        >;
        if (Array.isArray(parsed)) {
          providedFrames = parsed.reduce((acc, frame) => {
            if (!frame || typeof frame !== "object" || !frame.phase || !frame.imageBase64) return acc;
            const normalized = parseDataUrl(frame.imageBase64);
            if (!normalized) return acc;
            acc[frame.phase] = {
              base64Image: normalized.base64Image,
              mimeType: normalized.mimeType,
              timestampSec: typeof frame.timestamp === "number" ? frame.timestamp : undefined,
            } as PhaseFrame;
            return acc;
          }, {} as Partial<PhaseFrames>);
        }
      } catch (error) {
        console.warn("[golf/analyze] failed to parse phaseFramesJson", error);
      }
    }

    if (!providedFrames && inlinePhaseFrames.length) {
      const normalized = inlinePhaseFrames
        .map((entry) => (typeof entry === "string" ? parseDataUrl(entry) : null))
        .filter(Boolean) as Array<{ base64Image: string; mimeType: string }>;

      if (normalized.length) {
        providedFrames = {} as Partial<PhaseFrames>;
        normalized.forEach((value, idx) => {
          const phase = clientPhaseOrder[idx] ?? clientPhaseOrder[clientPhaseOrder.length - 1];
          providedFrames![phase] = { base64Image: value.base64Image, mimeType: value.mimeType } as PhaseFrame;
        });
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";

    const extractedFrames = await extractPhaseFrames({ buffer, mimeType });
    const frames = mergePhaseFrames(providedFrames, extractedFrames);

    let previousReport: SwingAnalysis | null = null;
    if (typeof previousAnalysisId === "string") {
      previousReport = getAnalysis(previousAnalysisId)?.result ?? null;
    }

    if (!previousReport && typeof previousReportJson === "string") {
      try {
        const parsed = JSON.parse(previousReportJson) as SwingAnalysis;
        if (parsed && typeof parsed === "object") {
          previousReport = parsed;
        }
      } catch (error) {
        console.warn("[golf/analyze] failed to parse previousReportJson", error);
      }
    }

    const prompt = genPrompt(meta, previousReport);

    // 🚨 修正：
    // Vision に渡すフレーム順は「必ずクライアントが決めた順序」を使う。
    // fallback で独自並び替えするとフェーズがズレる原因になる。

    const PHASE_ORDER: PhaseKey[] = [
      "address",
      "backswing",
      "top",
      "downswing",
      "impact",
      "finish",
    ];

    const visionFrames: PhaseFrame[] = PHASE_ORDER
      .map((phase) => frames[phase])
      .filter((f): f is PhaseFrame => !!f);

    const jsonText = await askVisionAPI({ frames: visionFrames, prompt });
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
      comparison: parsed.comparison,
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
