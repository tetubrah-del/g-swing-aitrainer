import { NextRequest, NextResponse } from "next/server";
import { buildUserUsageState } from "@/app/lib/membership";
import { upsertGoogleUser } from "@/app/lib/userStore";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string | null;
      googleSub?: string | null;
      anonymousUserId?: string | null;
    };

    const email = typeof body.email === "string" && body.email.trim().length ? body.email.trim() : null;
    const anonymousUserId =
      typeof body.anonymousUserId === "string" && body.anonymousUserId.trim().length ? body.anonymousUserId.trim() : null;
    const googleSub =
      typeof body.googleSub === "string" && body.googleSub.trim().length ? body.googleSub.trim() : null;

    if (!googleSub) {
      return NextResponse.json({ error: "googleSub required (OAuth token not implemented in MVP)" }, { status: 400 });
    }

    const account = await upsertGoogleUser({
      googleSub,
      email,
      anonymousUserId,
    });

    const userState = await buildUserUsageState({ user: account, anonymousUserId });

    return NextResponse.json({
      ok: true,
      user: { userId: account.userId, email: account.email, plan: account.plan },
      userState,
    });
  } catch (error) {
    console.error("[register/google] failed", error);
    return NextResponse.json({ error: "failed to register with Google" }, { status: 500 });
  }
}
