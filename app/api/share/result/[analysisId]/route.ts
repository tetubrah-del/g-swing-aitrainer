import { NextRequest, NextResponse } from "next/server";
import { getAnalysis } from "@/app/lib/store";
import { getSharedAnalysisSnapshot } from "@/app/lib/referralTracking";

export const runtime = "nodejs";

function isValidAnalysisId(id: string | null | undefined): id is string {
  if (!id) return false;
  return /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

export async function GET(_req: NextRequest, context: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await context.params;
  if (!isValidAnalysisId(analysisId)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const snapshot = getSharedAnalysisSnapshot(analysisId);
  if (snapshot) {
    return NextResponse.json(snapshot);
  }

  const stored = await getAnalysis(analysisId);
  if (!stored) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Keep it minimal & safe for SNS sharing (no faces / personal info / media).
  return NextResponse.json({
    analysisId,
    totalScore: stored.result?.totalScore ?? null,
    createdAt: stored.createdAt ?? null,
  });
}
