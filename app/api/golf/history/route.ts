import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { listAnalyses } from "@/app/lib/store";
import { getUserById, linkAnonymousIdToUser } from "@/app/lib/userStore";
import { readAnonymousFromRequest, setAnonymousTokenOnResponse } from "@/app/lib/anonymousToken";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const anonymousFromQuery = searchParams.get("anonymousUserId");
  const { anonymousUserId: tokenAnonymous } = readAnonymousFromRequest(req);
  const session = await auth();
  const isLoggedIn = !!session?.user?.id;
  // Only trust token-backed anonymousId. For legacy anonymous (not logged-in) with no token, allow query but do not mint token.
  const anonymousUserId = tokenAnonymous ?? (isLoggedIn ? null : anonymousFromQuery ?? null);
  const userId = session?.user?.id ?? null;
  let resolvedUserId: string | null = null;

  if (userId) {
    const user = await getUserById(userId);
    if (!user) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (anonymousUserId && !(user.anonymousIds ?? []).includes(anonymousUserId)) {
      await linkAnonymousIdToUser(user.userId, anonymousUserId);
    }
    resolvedUserId = user.userId;
  }

  if (!resolvedUserId && !anonymousUserId) {
    return NextResponse.json({ error: "user not specified" }, { status: 400 });
  }

  const records = await listAnalyses(
    { userId: resolvedUserId ?? undefined, anonymousUserId: anonymousUserId ?? undefined },
    { limit: 50, order: "desc" }
  );

  const items = records.map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    score: record.result?.totalScore ?? null,
    club: record.meta?.clubType ?? null,
    level: record.meta?.level ?? null,
  }));

  const access = userId ? "member" : "anonymous";

  const res = NextResponse.json({ items, access });
  if (tokenAnonymous) {
    setAnonymousTokenOnResponse(res, tokenAnonymous);
  }
  return res;
}
