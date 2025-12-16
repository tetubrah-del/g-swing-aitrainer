import { NextRequest, NextResponse } from "next/server";
import { buildUserUsageState } from "@/app/lib/membership";
import { registerEmailUser } from "@/app/lib/userStore";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { email?: string; anonymousUserId?: string | null };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const anonymousUserId = typeof body.anonymousUserId === "string" ? body.anonymousUserId.trim() : null;

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "valid email required" }, { status: 400 });
    }

    const account = await registerEmailUser({ email, anonymousUserId });
    const userState = await buildUserUsageState({ user: account, anonymousUserId });

    return NextResponse.json({
      ok: true,
      user: { userId: account.userId, email: account.email, plan: account.plan },
      userState,
    });
  } catch (error) {
    console.error("[register/email] failed", error);
    return NextResponse.json({ error: "failed to register" }, { status: 500 });
  }
}
