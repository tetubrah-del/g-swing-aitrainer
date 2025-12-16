import { ProAccessReason, UserAccount, UserState, UserUsageState } from "@/app/golf/types";
import { countMonthlyAnalyses } from "@/app/lib/store";
import { upsertGoogleUser } from "@/app/lib/userStore";

export const FREE_MONTHLY_ANALYSIS_LIMIT = 3;

export function hasProAccess(user: UserAccount | null, now: number = Date.now()): boolean {
  if (!user) return false;

  if (user.proAccess === true) {
    if (user.proAccessExpiresAt && now > user.proAccessExpiresAt) {
      return false;
    }
    return true;
  }

  return false;
}

export function resolveUserState(user: UserAccount | null, now: number = Date.now()): UserState {
  if (!user) return "anonymous";
  return hasProAccess(user, now) ? "pro" : "registered";
}

export async function buildUserUsageState(params: {
  user: UserAccount | null;
  anonymousUserId: string | null;
  now?: number;
  freeLimit?: number;
}): Promise<UserUsageState> {
  const now = params.now ?? Date.now();
  const limit = params.freeLimit ?? FREE_MONTHLY_ANALYSIS_LIMIT;
  const pro = hasProAccess(params.user, now);
  const used = await countMonthlyAnalyses(
    { userId: params.user?.userId ?? null, anonymousUserId: params.anonymousUserId },
    now
  );

  if (pro) {
    return {
      isAuthenticated: !!params.user,
      hasProAccess: true,
      isMonitor: params.user?.proAccessReason === "monitor",
      monthlyAnalysis: {
        used,
        limit: null,
        remaining: null,
      },
    };
  }

  const remaining = Math.max(0, limit - used);
  return {
    isAuthenticated: !!params.user,
    hasProAccess: false,
    isMonitor: false,
    monthlyAnalysis: {
      used,
      limit,
      remaining,
    },
  };
}

export async function resolveGoogleUserFromHeaders(params: {
  googleSub?: string | null;
  email?: string | null;
  anonymousUserId?: string | null;
  proAccess?: boolean;
  proAccessReason?: ProAccessReason | null;
  proAccessExpiresAt?: number | null;
}): Promise<UserAccount | null> {
  if (!params.googleSub && !params.email) return null;
  return upsertGoogleUser({
    googleSub: params.googleSub,
    email: params.email,
    anonymousUserId: params.anonymousUserId,
    proAccess: params.proAccess,
    proAccessReason: params.proAccessReason,
    proAccessExpiresAt: params.proAccessExpiresAt,
  });
}
