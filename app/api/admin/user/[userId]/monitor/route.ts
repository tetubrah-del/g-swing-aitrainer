import { NextRequest, NextResponse } from "next/server";
import { getServerAuthContext } from "@/app/lib/serverAccount";
import { isAdminEmail } from "@/app/lib/admin";
import { grantMonitorAccess, revokeMonitorAccess, getUserById } from "@/app/lib/userStore";

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

  const body = (await req.json().catch(() => ({}))) as { expiresAt?: unknown; days?: unknown };
  const daysRaw = typeof body.days === "number" ? body.days : typeof body.days === "string" ? Number(body.days) : null;
  const days = typeof daysRaw === "number" && Number.isFinite(daysRaw) ? Math.max(1, Math.min(3650, Math.trunc(daysRaw))) : null;
  const expiresAtRaw =
    typeof body.expiresAt === "number" ? body.expiresAt : typeof body.expiresAt === "string" ? Number(body.expiresAt) : null;
  const expiresAt =
    typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw)
      ? Math.trunc(expiresAtRaw)
      : days
        ? Date.now() + days * 24 * 60 * 60 * 1000
        : null;

  await grantMonitorAccess(userId, expiresAt);
  const updated = await getUserById(userId);
  return NextResponse.json({ ok: true, user: updated });
}

export async function DELETE(_req: NextRequest, context: { params: Promise<{ userId: string }> }) {
  const ctx = await getServerAuthContext();
  if (!isAdminEmail(ctx.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { userId } = await context.params;
  if (!isValidUserId(userId)) return NextResponse.json({ error: "invalid userId" }, { status: 400 });

  const updated = await revokeMonitorAccess(userId);
  return NextResponse.json({ ok: true, user: updated });
}

