import { NextRequest, NextResponse } from "next/server";
import { createEmailVerification } from "@/app/lib/emailVerificationStore";
import { sendVerificationEmail } from "@/app/lib/mailer";

const isValidEmail = (email: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

const sanitizeNext = (next: string | null | undefined): string | null => {
  if (!next) return null;
  if (!next.startsWith("/")) return null;
  return next;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      anonymousUserId?: string | null;
      next?: string | null;
    };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const anonymousUserId = typeof body.anonymousUserId === "string" ? body.anonymousUserId.trim() : null;
    const next = sanitizeNext(typeof body.next === "string" ? body.next : null);

    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: "valid email required" }, { status: 400 });
    }

    const { token, expiresAt } = await createEmailVerification({ email, anonymousUserId });

    const verifyUrl = new URL("/api/golf/register/email/verify", req.nextUrl.origin);
    verifyUrl.searchParams.set("token", token);
    if (next) verifyUrl.searchParams.set("next", next);

    const delivery = await sendVerificationEmail({ to: email, verifyUrl: verifyUrl.toString(), expiresAt });

    return NextResponse.json({
      ok: true,
      delivered: delivery.delivered,
      devLink: delivery.delivered ? undefined : verifyUrl.toString(),
    });
  } catch (error) {
    console.error("[register/email/request] failed", error);
    return NextResponse.json({ error: "failed to send verification" }, { status: 500 });
  }
}

