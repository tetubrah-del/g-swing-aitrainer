import { NextRequest, NextResponse } from "next/server";
import { AnalysisId } from "@/app/golf/types";
import { getAnalysis } from "@/app/lib/store";
import { auth } from "@/auth";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest } from "@/app/lib/activeAuth";
import { findUserByEmail, getUserById } from "@/app/lib/userStore";
import { getFeatures } from "@/app/lib/features";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const emailSession = readEmailSessionFromRequest(req);
  const activeAuth = readActiveAuthFromRequest(req) ?? (emailSession ? "email" : null);
  let account = null;
  if (activeAuth !== "email") {
    const session = await auth();
    const sessionUserId = session?.user?.id ?? null;
    account = sessionUserId ? await getUserById(sessionUserId) : null;
  }
  if (!account && activeAuth !== "google" && emailSession) {
    const byId = await getUserById(emailSession.userId);
    if (
      byId &&
      byId.authProvider === "email" &&
      byId.emailVerifiedAt != null &&
      typeof byId.email === "string" &&
      byId.email.toLowerCase() === emailSession.email.toLowerCase()
    ) {
      account = byId;
    } else {
      const byEmail = await findUserByEmail(emailSession.email);
      if (byEmail && byEmail.authProvider === "email" && byEmail.emailVerifiedAt != null) {
        account = byEmail;
      }
    }
  }

  const now = Date.now();
  const isPro = !!account?.proAccess && (account.proAccessExpiresAt == null || account.proAccessExpiresAt > now);
  const features = getFeatures({ remainingCount: null, isPro });
  if (!features.comparison) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

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
