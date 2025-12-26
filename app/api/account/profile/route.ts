import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { findUserByEmail, getUserById, updateUserNickname } from "@/app/lib/userStore";
import { readEmailSessionFromRequest } from "@/app/lib/emailSession";
import { readActiveAuthFromRequest } from "@/app/lib/activeAuth";

export const runtime = "nodejs";

function normalizeNickname(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  return trimmed.slice(0, 24);
}

async function resolveAccount(req: NextRequest) {
  const emailSession = readEmailSessionFromRequest(req);
  const activeAuth = readActiveAuthFromRequest(req) ?? (emailSession ? "email" : null);

  let account = null;
  if (activeAuth !== "email") {
    const session = await auth();
    const sessionUserId = session?.user?.id ?? null;
    const sessionEmail = session?.user?.email ?? null;
    account = sessionUserId ? await getUserById(sessionUserId) : null;
    if (!account && sessionEmail) {
      account = await findUserByEmail(sessionEmail);
    }
  }

  if (!account && activeAuth !== "google" && emailSession) {
    const byId = await getUserById(emailSession.userId);
    if (
      byId &&
      byId.authProvider === "email" &&
      typeof byId.email === "string" &&
      byId.email.toLowerCase() === emailSession.email.toLowerCase()
    ) {
      account = byId;
    } else {
      const byEmail = await findUserByEmail(emailSession.email);
      if (byEmail && byEmail.authProvider === "email") {
        account = byEmail;
      }
    }
  }

  return account;
}

export async function GET(req: NextRequest) {
  const account = await resolveAccount(req);
  if (!account?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    userId: account.userId,
    email: account.email ?? null,
    nickname: account.nickname ?? null,
  });
}

export async function PATCH(req: NextRequest) {
  const account = await resolveAccount(req);
  if (!account?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { nickname?: unknown };
  const nickname = normalizeNickname(body.nickname);
  const updated = await updateUserNickname({ userId: account.userId, nickname });
  return NextResponse.json({
    ok: true,
    userId: updated.userId,
    email: updated.email ?? null,
    nickname: updated.nickname ?? null,
  });
}

