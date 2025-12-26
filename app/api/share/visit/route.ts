import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isValidReferralCode, recordReferralVisit } from "@/app/lib/referralTracking";

export const runtime = "nodejs";

const REFERRAL_CODE_COOKIE = "referral_code";
const REFERRAL_SESSION_COOKIE = "referral_session_id";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

function isValidSessionId(value: string | null | undefined): value is string {
  if (!value) return false;
  return /^[A-Za-z0-9_-]{6,200}$/.test(value);
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { referralCode?: unknown };
  const referralCode = typeof body.referralCode === "string" ? body.referralCode : null;
  if (!isValidReferralCode(referralCode)) {
    return NextResponse.json({ error: "invalid referralCode" }, { status: 400 });
  }

  const existingSession = req.cookies.get(REFERRAL_SESSION_COOKIE)?.value ?? null;
  const sessionId = isValidSessionId(existingSession) ? existingSession : crypto.randomUUID();

  try {
    recordReferralVisit({ referralCode, sessionId });
  } catch (e) {
    console.error("[share:visit] failed to record", e);
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(REFERRAL_CODE_COOKIE, referralCode, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  res.cookies.set(REFERRAL_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}

