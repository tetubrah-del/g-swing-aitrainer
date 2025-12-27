import { NextRequest, NextResponse } from "next/server";
import { getSharedAnalysisDetail, upsertSharedAnalysisDetail } from "@/app/lib/referralTracking";
import { getAnalysis } from "@/app/lib/store";
import { getUserById } from "@/app/lib/userStore";
import { selectShareFrames } from "@/app/golf/utils/shareFrameSelection";

export const runtime = "nodejs";

function isValidAnalysisId(id: string | null | undefined): id is string {
  if (!id) return false;
  return /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

export async function GET(_req: NextRequest, context: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await context.params;
  if (!isValidAnalysisId(analysisId)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  let detail = getSharedAnalysisDetail(analysisId);
  if (!detail) {
    const stored = await getAnalysis(analysisId);
    if (stored) {
      try {
        const allFrames = (stored.result?.sequence?.frames ?? []).slice(0, 16).map((f) => f.url).filter((u) => typeof u === "string");
        const stageIndices = Array.from(
          new Set(
            (stored.result?.sequence?.stages ?? [])
              .flatMap((s) => (Array.isArray(s.keyFrameIndices) ? s.keyFrameIndices : []))
              .filter((n) => typeof n === "number" && Number.isFinite(n))
              .map((n) => Math.max(1, Math.min(allFrames.length || 16, Math.round(n)))),
          ),
        ).sort((a, b) => a - b);
        const selectedFrames = selectShareFrames({
          allFrames,
          stageIndices,
          desiredCount: 7,
        });

        let nickname: string | null = null;
        if (stored.userId) {
          const owner = await getUserById(stored.userId);
          nickname = owner?.nickname ?? null;
        }
        upsertSharedAnalysisDetail(analysisId, {
          analysisId,
          nickname,
          totalScore: typeof stored.result?.totalScore === "number" ? stored.result.totalScore : null,
          createdAt: typeof stored.createdAt === "number" ? stored.createdAt : null,
          phases: stored.result?.phases ?? null,
          summary: stored.result?.summary ?? null,
          recommendedDrills: stored.result?.recommendedDrills ?? [],
          selectedFrames,
        });
      } catch {}
      detail = getSharedAnalysisDetail(analysisId);
    }
  }

  if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Keep nickname up-to-date even if the cached share detail was generated earlier.
  try {
    const stored = await getAnalysis(analysisId);
    if (stored?.userId) {
      const owner = await getUserById(stored.userId);
      const ownerNickname = owner?.nickname ?? null;
      if (ownerNickname) {
        const payload = detail.payload as unknown;
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          return NextResponse.json({
            analysisId: detail.analysisId,
            payload: { ...(payload as Record<string, unknown>), nickname: ownerNickname },
            updatedAt: detail.updatedAt,
          });
        }
        return NextResponse.json({
          analysisId: detail.analysisId,
          payload: { nickname: ownerNickname },
          updatedAt: detail.updatedAt,
        });
      }
    }
  } catch {
    // ignore nickname enrichment failures
  }

  return NextResponse.json({ analysisId: detail.analysisId, payload: detail.payload, updatedAt: detail.updatedAt });
}
