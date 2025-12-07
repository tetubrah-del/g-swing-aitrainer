// app/api/golf/result/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import {
  AnalysisId,
  GolfAnalysisResult,
  MOCK_GOLF_ANALYSIS_RESULT,
  getAnalysisResult,
} from "@/app/golf/types";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  // Next.js 16: params は Promise のため await 必須
  const { id } = await context.params;
  const analysisId = id as AnalysisId;

  const stored = getAnalysisResult(analysisId);

  if (!stored) {
    return NextResponse.json(
      {
        analysisId,
        result: MOCK_GOLF_ANALYSIS_RESULT,
        note: "MVPダミー: 実データがないためサンプル結果を返しています。",
      },
      { status: 200 }
    );
  }

  return NextResponse.json(
    {
      analysisId,
      result: stored.result as GolfAnalysisResult,
      meta: stored.meta,
      createdAt: stored.createdAt,
    },
    { status: 200 }
  );
}
