// app/api/golf/result/[id]/route.ts

import { NextRequest, NextResponse } from "next/server";
import { AnalysisId, GolfAnalysisResponse, MOCK_GOLF_ANALYSIS_RESULT } from "@/app/golf/types";
import { getAnalysis } from "@/app/lib/store";
import { getUserById, linkAnonymousIdToUser } from "@/app/lib/userStore";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { auth } from "@/auth";

export const runtime = "nodejs";

function json<T>(body: T, init: { status: number }) {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function isValidAnalysisId(id: string | null | undefined): id is AnalysisId {
  if (!id) return false;
  // Allow simple uuid-ish / slug ids, reject obviously invalid input
  return /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

export async function GET(
  req: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse<GolfAnalysisResponse | { error: string }>> {
  const { id } = context.params;
  if (!isValidAnalysisId(id)) {
    return json({ error: "invalid id" }, { status: 400 });
  }
  const analysisId = id as AnalysisId;

  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(req);
  const session = await auth();
  const sessionUserId = session?.user?.id ?? null;

  // Existence-hiding: if caller has neither auth nor token-backed anonymous id, always return 404.
  if (!sessionUserId && !tokenAnonymous) {
    return json({ error: "not found" }, { status: 404 });
  }

  const stored = await getAnalysis(analysisId);

  if (!stored) {
    if (process.env.NODE_ENV !== "production") {
      return json(
        {
          analysisId,
          result: MOCK_GOLF_ANALYSIS_RESULT,
          note: "MVPダミー: 実データがないためサンプル結果を返しています。",
        },
        { status: 200 }
      );
    }
    return json({ error: "not found" }, { status: 404 });
  }

  if (sessionUserId) {
    const user = await getUserById(sessionUserId);
    if (!user) {
      return json({ error: "not found" }, { status: 404 });
    }
    const recordHasUser = stored.userId != null;
    const ownsByUser = recordHasUser && stored.userId === user.userId;
    const ownsByLinkedAnonymous =
      !recordHasUser &&
      !!stored.anonymousUserId &&
      Array.isArray(user.anonymousIds) &&
      user.anonymousIds.includes(stored.anonymousUserId);
    const ownsByTokenAnonymous =
      !recordHasUser && !!tokenAnonymous && !!stored.anonymousUserId && stored.anonymousUserId === tokenAnonymous;

    if (!ownsByUser && !ownsByLinkedAnonymous && !ownsByTokenAnonymous) {
      return json({ error: "not found" }, { status: 404 });
    }

    // Link missing anonymousId -> user when token matches the record
    if (
      ownsByTokenAnonymous &&
      stored.anonymousUserId &&
      (!user.anonymousIds || !user.anonymousIds.includes(stored.anonymousUserId))
    ) {
      await linkAnonymousIdToUser(user.userId, stored.anonymousUserId);
    }
  } else {
    // Anonymous caller: only allow token-backed anonymous access, and only for records not already owned by a user.
    if (stored.userId != null || !stored.anonymousUserId || stored.anonymousUserId !== tokenAnonymous) {
      return json({ error: "not found" }, { status: 404 });
    }
  }

  return json(
    {
      analysisId,
      result: stored.result,
      meta: stored.meta,
      createdAt: stored.createdAt,
    },
    { status: 200 }
  );
}
