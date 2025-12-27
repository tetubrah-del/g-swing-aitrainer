import { NextRequest, NextResponse } from "next/server";
import { getServerAuthContext } from "@/app/lib/serverAccount";
import { isAdminEmail } from "@/app/lib/admin";
import { disableUserAccount, enableUserAccount, getUserById } from "@/app/lib/userStore";

export const runtime = "nodejs";

function isValidUserId(id: string | null | undefined): id is string {
  if (!id) return false;
  return /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

export async function POST(req: NextRequest, context: { params: Promise<{ userId: string }> }) {
  const ctx = await getServerAuthContext();
  if (!isAdminEmail(ctx.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { userId } = await context.params;
  if (!isValidUserId(userId)) return NextResponse.json({ error: "invalid userId" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { reason?: unknown; anonymize?: unknown };
  const reason = typeof body.reason === "string" ? body.reason : null;
  const anonymize = body.anonymize === true;

  await disableUserAccount({ userId, reason, anonymize });
  const updated = await getUserById(userId);
  return NextResponse.json({ ok: true, user: updated });
}

export async function DELETE(_req: NextRequest, context: { params: Promise<{ userId: string }> }) {
  const ctx = await getServerAuthContext();
  if (!isAdminEmail(ctx.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { userId } = await context.params;
  if (!isValidUserId(userId)) return NextResponse.json({ error: "invalid userId" }, { status: 400 });

  const updated = await enableUserAccount({ userId });
  return NextResponse.json({ ok: true, user: updated });
}

