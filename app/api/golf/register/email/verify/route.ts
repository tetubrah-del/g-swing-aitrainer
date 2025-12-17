import { NextRequest, NextResponse } from "next/server";
import { consumeEmailVerification } from "@/app/lib/emailVerificationStore";
import { registerEmailUser } from "@/app/lib/userStore";
import { setEmailSessionOnResponse } from "@/app/lib/emailSession";
import { readAnonymousFromRequest } from "@/app/lib/anonymousToken";
import { setActiveAuthOnResponse } from "@/app/lib/activeAuth";

const sanitizeNext = (next: string | null, fallback: string): string => {
  if (!next || !next.startsWith("/")) return fallback;
  return next;
};

const appendRegistered = (target: string): string => {
  try {
    const url = new URL(target, "http://local");
    url.searchParams.set("registered", "1");
    return url.pathname + url.search + url.hash;
  } catch {
    return target;
  }
};

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const next = req.nextUrl.searchParams.get("next");
  const target = appendRegistered(sanitizeNext(next, "/golf/history"));

  if (!token) {
    return NextResponse.redirect(new URL(`/golf/register?error=missing_token&next=${encodeURIComponent(target)}`, req.nextUrl.origin));
  }

  try {
    const { anonymousUserId: cookieAnonymous } = readAnonymousFromRequest(req);
    const record = await consumeEmailVerification(token);
    const anonymousUserId = cookieAnonymous ?? record.anonymousUserId ?? null;

    const account = await registerEmailUser({ email: record.email, anonymousUserId });

    const res = NextResponse.redirect(new URL(target, req.nextUrl.origin));
    if (account.email) {
      setEmailSessionOnResponse(res, { userId: account.userId, email: account.email });
      setActiveAuthOnResponse(res, "email");
    }
    return res;
  } catch (error) {
    console.error("[register/email/verify] failed", error);
    return NextResponse.redirect(new URL(`/golf/register?error=invalid_token&next=${encodeURIComponent(target)}`, req.nextUrl.origin));
  }
}
