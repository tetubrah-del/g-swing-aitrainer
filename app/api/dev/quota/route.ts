import { NextRequest, NextResponse } from "next/server";
import { canAnalyzeNow } from "@/app/lib/quota";
import { findUserByEmail, getUserById, saveUser } from "@/app/lib/userStore";
import { getAnonymousQuotaCount, setAnonymousQuotaCount } from "@/app/lib/quotaStore";
import type { User, UserPlan } from "@/app/types/user";

type InspectResponse = {
  ok: true;
  input: { email?: string | null; userId?: string | null };
  user: {
    userId: string;
    email: string | null;
    plan: string | null;
    freeAnalysisCount: number;
    anonymousIds: string[];
  } | null;
  anonymousQuota: Record<string, number>;
  effectiveUsed: number;
  limit: number | null;
  canAnalyzeNow: { allowed: true } | { allowed: false; reason: string };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toUserPlan(params: { email: string | null; plan: unknown; proAccess?: boolean }): UserPlan {
  if (params.proAccess) return "pro";
  if (params.plan === "pro" || params.plan === "free" || params.plan === "anonymous") return params.plan;
  return params.email ? "free" : "anonymous";
}

function limitFor(user: { email: string | null; plan: UserPlan } | null): number | null {
  if (!user) return 1;
  if (user.email === null) return 1;
  if (user.plan === "free") return 3;
  return null;
}

async function inspect(params: { email?: string | null; userId?: string | null }): Promise<InspectResponse> {
  const email = isNonEmptyString(params.email) ? params.email.trim().toLowerCase() : null;
  const userId = isNonEmptyString(params.userId) ? params.userId.trim() : null;

  const account = userId ? await getUserById(userId) : email ? await findUserByEmail(email) : null;
  const anonymousIds = Array.isArray(account?.anonymousIds) ? account!.anonymousIds : [];
  const anonymousQuotaEntries = await Promise.all(
    anonymousIds.map(async (id) => [id, await getAnonymousQuotaCount(id)] as const)
  );
  const anonymousQuota = Object.fromEntries(anonymousQuotaEntries);
  const maxAnonymous = anonymousQuotaEntries.reduce((max, [, count]) => Math.max(max, count), 0);
  const effectiveUsed = Math.max(account?.freeAnalysisCount ?? 0, maxAnonymous);

  const userForPermission: User = account
    ? {
        id: account.userId,
        plan: toUserPlan({ email: account.email ?? null, plan: account.plan, proAccess: account.proAccess === true }),
        email: account.email ?? null,
        authProvider: account.authProvider ?? null,
        isMonitor: account.proAccessReason === "monitor",
        monitorExpiresAt: account.monitorExpiresAt ? new Date(account.monitorExpiresAt) : null,
        freeAnalysisCount: effectiveUsed,
        freeAnalysisResetAt: account.freeAnalysisResetAt ? new Date(account.freeAnalysisResetAt) : new Date(0),
        createdAt: new Date(account.createdAt ?? Date.now()),
      }
    : {
        id: "anonymous",
        plan: "anonymous",
        email: null,
        authProvider: null,
        isMonitor: false,
        monitorExpiresAt: null,
        freeAnalysisCount: 0,
        freeAnalysisResetAt: new Date(0),
        createdAt: new Date(),
      };

  return {
    ok: true,
    input: { email, userId },
    user: account
      ? {
          userId: account.userId,
          email: account.email ?? null,
          plan: account.plan ?? null,
          freeAnalysisCount: account.freeAnalysisCount ?? 0,
          anonymousIds,
        }
      : null,
    anonymousQuota,
    effectiveUsed,
    limit: account
      ? limitFor({
          email: account.email ?? null,
          plan: toUserPlan({ email: account.email ?? null, plan: account.plan, proAccess: account.proAccess === true }),
        })
      : limitFor(null),
    canAnalyzeNow: canAnalyzeNow(userForPermission),
  };
}

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const email = req.nextUrl.searchParams.get("email");
  const userId = req.nextUrl.searchParams.get("userId");
  const result = await inspect({ email, userId });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    userId?: string;
    action?: "reset" | "set_free_count";
    freeAnalysisCount?: number;
    resetAnonymousQuota?: boolean;
  };

  const email = isNonEmptyString(body.email) ? body.email.trim().toLowerCase() : null;
  const userId = isNonEmptyString(body.userId) ? body.userId.trim() : null;
  const action = body.action ?? "reset";
  const resetAnonymousQuota = body.resetAnonymousQuota !== false;

  const account = userId ? await getUserById(userId) : email ? await findUserByEmail(email) : null;
  if (!account) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  if (action === "set_free_count") {
    const next = Number.isFinite(body.freeAnalysisCount) ? Math.max(0, Math.floor(body.freeAnalysisCount!)) : null;
    if (next === null) {
      return NextResponse.json({ error: "freeAnalysisCount required" }, { status: 400 });
    }
    await saveUser({ ...account, freeAnalysisCount: next, updatedAt: Date.now() });
    return NextResponse.json(await inspect({ userId: account.userId }));
  }

  // reset
  await saveUser({ ...account, freeAnalysisCount: 0, updatedAt: Date.now() });
  if (resetAnonymousQuota) {
    for (const id of account.anonymousIds ?? []) {
      await setAnonymousQuotaCount(id, 0);
    }
  }

  return NextResponse.json(await inspect({ userId: account.userId }));
}
