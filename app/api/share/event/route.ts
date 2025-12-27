import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  ShareSnsType,
  recordShareEvent,
  upsertSharedAnalysisDetail,
  upsertSharedAnalysisSnapshot,
} from "@/app/lib/referralTracking";
import { getBaseUrl } from "@/app/lib/billing/stripe";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest } from "@/app/lib/activeAuth";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import { getAnalysis } from "@/app/lib/store";
import { selectShareFrames } from "@/app/golf/utils/shareFrameSelection";

export const runtime = "nodejs";

async function resolveActor(req: NextRequest): Promise<{ userId: string; nickname: string | null } | null> {
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(req);
  const emailSession = readEmailSessionFromRequest(req);
  const activeAuth = readActiveAuthFromRequest(req) ?? (emailSession ? "email" : null);

  let account = null;
  if (activeAuth !== "email") {
    const session = await auth();
    const sessionUserId = session?.user?.id ?? null;
    const sessionEmail = session?.user?.email ?? null;
    account = sessionUserId ? await getUserById(sessionUserId) : null;
    if (!account && sessionEmail) account = await findUserByEmail(sessionEmail);
  }

  if (!account && activeAuth !== "google" && emailSession) {
    const byId = await getUserById(emailSession.userId);
    if (byId && byId.authProvider === "email") account = byId;
  }

  if (account?.userId) return { userId: account.userId, nickname: account.nickname ?? null };
  if (tokenAnonymous) return { userId: tokenAnonymous, nickname: null };
  return null;
}

function isSnsType(value: unknown): value is ShareSnsType {
  return value === "twitter" || value === "instagram" || value === "copy";
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    analysisId?: unknown;
    snsType?: unknown;
    totalScore?: unknown;
    createdAt?: unknown;
    sharePayload?: unknown;
  };
  const analysisId = typeof body.analysisId === "string" ? body.analysisId : null;
  const snsType = body.snsType;

  if (!analysisId) return NextResponse.json({ error: "analysisId required" }, { status: 400 });
  if (!isSnsType(snsType)) return NextResponse.json({ error: "invalid snsType" }, { status: 400 });

  const actor = await resolveActor(req);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const referralCode = recordShareEvent({ userId: actor.userId, analysisId, snsType });

  // Snapshot share-safe fields so /share can display even if analysis storage is ephemeral.
  let responseTotalScore: number | null = null;
  let responseCreatedAt: number | null = null;
  try {
    const totalScoreValue =
      typeof body.totalScore === "number"
        ? body.totalScore
        : typeof body.totalScore === "string"
          ? Number(body.totalScore)
          : null;
    const totalScore = typeof totalScoreValue === "number" && Number.isFinite(totalScoreValue) ? totalScoreValue : null;

    const createdAtValue =
      typeof body.createdAt === "number" ? body.createdAt : typeof body.createdAt === "string" ? Number(body.createdAt) : null;
    const createdAt = typeof createdAtValue === "number" && Number.isFinite(createdAtValue) ? createdAtValue : null;
    if (totalScore != null || createdAt != null) {
      upsertSharedAnalysisSnapshot({ analysisId, totalScore, createdAt });
      responseTotalScore = totalScore;
      responseCreatedAt = createdAt;
    } else {
      const stored = await getAnalysis(analysisId);
      if (stored) {
        responseTotalScore = typeof stored.result?.totalScore === "number" ? stored.result.totalScore : null;
        responseCreatedAt = typeof stored.createdAt === "number" ? stored.createdAt : null;
        upsertSharedAnalysisSnapshot({
          analysisId,
          totalScore: responseTotalScore,
          createdAt: responseCreatedAt,
        });
      }
    }
  } catch (e) {
    console.warn("[share:event] snapshot failed", e);
  }

  // Store share detail payload (for the rich share page UI).
  try {
    if (body.sharePayload && typeof body.sharePayload === "object") {
      upsertSharedAnalysisDetail(analysisId, { ...body.sharePayload, nickname: actor.nickname });
    } else {
      const stored = await getAnalysis(analysisId);
      if (stored) {
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

        upsertSharedAnalysisDetail(analysisId, {
          analysisId,
          nickname: actor.nickname,
          totalScore: typeof stored.result?.totalScore === "number" ? stored.result.totalScore : null,
          createdAt: typeof stored.createdAt === "number" ? stored.createdAt : null,
          phases: stored.result?.phases ?? null,
          summary: stored.result?.summary ?? null,
          recommendedDrills: stored.result?.recommendedDrills ?? [],
          selectedFrames,
        });
      }
    }
  } catch (e) {
    console.warn("[share:event] detail snapshot failed", e);
  }

  const url = new URL(`${getBaseUrl()}/share/${encodeURIComponent(analysisId)}`);
  url.searchParams.set("ref", referralCode);
  // Query fallback so the page can render even without client JS / without DB access.
  if (responseTotalScore != null) url.searchParams.set("s", String(responseTotalScore));
  if (responseCreatedAt != null) url.searchParams.set("t", String(responseCreatedAt));
  // Fragment fallback (kept for backwards compatibility).
  if (responseTotalScore != null || responseCreatedAt != null) {
    const frag = new URLSearchParams();
    if (responseTotalScore != null) frag.set("s", String(responseTotalScore));
    if (responseCreatedAt != null) frag.set("t", String(responseCreatedAt));
    url.hash = frag.toString();
  }
  const shareUrl = url.toString();
  return NextResponse.json({ shareUrl });
}
