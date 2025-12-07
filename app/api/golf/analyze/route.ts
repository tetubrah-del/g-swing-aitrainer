// app/api/golf/analyze/route.ts

import { NextRequest, NextResponse } from "next/server";
import {
  AnalysisId,
  GolfAnalyzeMeta,
  MOCK_GOLF_ANALYSIS_RESULT,
  saveAnalysisResult,
} from "@/app/golf/types";

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

    // file が File かどうかのチェック（今は使わないが一応）
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "file is required" },
        { status: 400 }
      );
    }

    // メタ情報のバリデーション（ざっくり）
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

    // ★MVPダミー：ここで本来は Vision API を叩くが、
    //   いったん MOCK_GOLF_ANALYSIS_RESULT をそのまま使う
    const analysisId: AnalysisId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `golf-${Date.now()}`;

    // メタ情報を反映してもOKだが、まずはそのまま保存
    saveAnalysisResult(analysisId, {
      ...MOCK_GOLF_ANALYSIS_RESULT,
    });

    // 最低限 analysisId を返す
    return NextResponse.json({ analysisId });
  } catch (error) {
    console.error("[golf/analyze] error:", error);
    return NextResponse.json(
      { error: "internal server error" },
      { status: 500 }
    );
  }
}
