import { NextRequest, NextResponse } from "next/server";
import { AnalysisId } from "@/app/golf/types";
import { getAnalysis } from "@/app/lib/store";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const idA = searchParams.get("idA") as AnalysisId | null;
  const idB = searchParams.get("idB") as AnalysisId | null;

  if (!idA || !idB) {
    return NextResponse.json({ error: "idA and idB are required" }, { status: 400 });
  }

  const resultA = await getAnalysis(idA);
  const resultB = await getAnalysis(idB);

  return NextResponse.json(
    {
      existsA: Boolean(resultA),
      existsB: Boolean(resultB),
      resultA: resultA?.result ?? null,
      resultB: resultB?.result ?? null,
    },
    { status: 200 }
  );
}
