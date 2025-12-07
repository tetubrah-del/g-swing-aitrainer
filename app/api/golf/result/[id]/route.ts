// app/api/golf/result/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { AnalysisId, GolfAnalysisResponse, MOCK_GOLF_ANALYSIS_RESULT } from "@/app/golf/types";
import { getAnalysis } from "@/app/lib/store";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse<GolfAnalysisResponse>> {
  // Next.js 16: params は Promise のため await 必須
  const { id } = await context.params;
  const analysisId = id as AnalysisId;

  const stored = getAnalysis(analysisId);

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
      result: stored.result,
      meta: stored.meta,
      createdAt: stored.createdAt,
    },
    { status: 200 }
  );
}
