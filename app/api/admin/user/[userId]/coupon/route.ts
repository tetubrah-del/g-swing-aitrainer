import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServerAuthContext } from "@/app/lib/serverAccount";
import { isAdminEmail } from "@/app/lib/admin";
import { grantCoupon, listCouponGrants } from "@/app/lib/referralTracking";

export const runtime = "nodejs";

function isValidUserId(id: string | null | undefined): id is string {
  if (!id) return false;
  return /^[A-Za-z0-9_-]{6,200}$/.test(id);
}

function generateCouponCode() {
  return crypto.randomBytes(10).toString("base64url");
}

export async function GET(_req: NextRequest, context: { params: Promise<{ userId: string }> }) {
  const ctx = await getServerAuthContext();
  if (!isAdminEmail(ctx.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { userId } = await context.params;
  if (!isValidUserId(userId)) return NextResponse.json({ error: "invalid userId" }, { status: 400 });

  const coupons = listCouponGrants(userId);
  return NextResponse.json({ ok: true, coupons });
}

export async function POST(req: NextRequest, context: { params: Promise<{ userId: string }> }) {
  const ctx = await getServerAuthContext();
  if (!isAdminEmail(ctx.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { userId } = await context.params;
  if (!isValidUserId(userId)) return NextResponse.json({ error: "invalid userId" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { note?: unknown; expiresAt?: unknown; expiresDays?: unknown };
  const note = typeof body.note === "string" ? body.note : null;

  const expiresDaysRaw =
    typeof body.expiresDays === "number" ? body.expiresDays : typeof body.expiresDays === "string" ? Number(body.expiresDays) : null;
  const expiresDays =
    typeof expiresDaysRaw === "number" && Number.isFinite(expiresDaysRaw)
      ? Math.max(1, Math.min(3650, Math.trunc(expiresDaysRaw)))
      : null;

  const expiresAtRaw =
    typeof body.expiresAt === "number" ? body.expiresAt : typeof body.expiresAt === "string" ? Number(body.expiresAt) : null;
  const expiresAt =
    typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw)
      ? Math.trunc(expiresAtRaw)
      : expiresDays
        ? Date.now() + expiresDays * 24 * 60 * 60 * 1000
        : null;

  const code = generateCouponCode();
  const granted = grantCoupon({ userId, code, note, expiresAt, createdBy: ctx.email ?? null });
  return NextResponse.json({ ok: true, coupon: granted });
}

