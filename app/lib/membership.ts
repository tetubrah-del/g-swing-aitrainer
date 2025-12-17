import { ProAccessReason, UserAccount, UserState, UserUsageState } from "@/app/golf/types";
import { findUserByEmail, getUserById, upsertGoogleUser } from "@/app/lib/userStore";
import { getAnonymousQuotaCount } from "@/app/lib/quotaStore";

export const FREE_MONTHLY_ANALYSIS_LIMIT = 3;
export const ANONYMOUS_ANALYSIS_LIMIT = 1;

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
  const anonymousUsed = params.anonymousUserId ? await getAnonymousQuotaCount(params.anonymousUserId) : 0;
  const used = params.user ? Math.max(params.user.freeAnalysisCount ?? 0, anonymousUsed) : anonymousUsed;
  const baseProfile = {
    plan: params.user?.plan ?? (params.user?.email ? "free" : "anonymous"),
    email: params.user?.email ?? null,
    userId: params.user?.userId ?? null,
    anonymousUserId: params.anonymousUserId,
    freeAnalysisCount: params.user ? Math.max(params.user.freeAnalysisCount ?? 0, anonymousUsed) : anonymousUsed,
    authProvider: params.user?.authProvider ?? null,
  };

  if (pro) {
    return {
      isAuthenticated: !!params.user,
      hasProAccess: true,
      isMonitor: params.user?.proAccessReason === "monitor",
      ...baseProfile,
      monthlyAnalysis: {
        used,
        limit: null,
        remaining: null,
      },
    };
  }

  const effectiveLimit = baseProfile.plan === "anonymous" ? ANONYMOUS_ANALYSIS_LIMIT : limit;
  const remaining = Math.max(0, effectiveLimit - used);
  return {
    isAuthenticated: !!params.user,
    hasProAccess: false,
    isMonitor: false,
    ...baseProfile,
    monthlyAnalysis: {
      used,
      limit: effectiveLimit,
      remaining,
    },
  };
}

export async function resolveUserAccountFromHeaders(params: {
  userId?: string | null;
  email?: string | null;
  anonymousUserId?: string | null;
  authProvider?: "google" | "email" | null;
  proAccess?: boolean;
  proAccessReason?: ProAccessReason | null;
  proAccessExpiresAt?: number | null;
}): Promise<UserAccount | null> {
  const provider = params.authProvider;
  if (provider === "google") {
    if (!params.userId) return null;
    const byId = await getUserById(params.userId);
    if (!byId) return null;
    if (params.anonymousUserId && !(byId.anonymousIds ?? []).includes(params.anonymousUserId)) return null;
    return byId;
  }

  if (params.userId) {
    const byId = await getUserById(params.userId);
    if (byId) {
      if (params.anonymousUserId && !(byId.anonymousIds ?? []).includes(params.anonymousUserId)) {
        return null;
      }
      return byId;
    }
  }

  if (params.email) {
    const byEmail = await findUserByEmail(params.email);
    if (byEmail) {
      if (params.anonymousUserId && !(byEmail.anonymousIds ?? []).includes(params.anonymousUserId)) {
        return null;
      }
      return byEmail;
    }
  }

  if (provider === "google" || params.proAccess || params.proAccessReason) {
    return upsertGoogleUser({
      googleSub: params.userId,
      email: params.email,
      anonymousUserId: params.anonymousUserId,
      proAccess: params.proAccess,
      proAccessReason: params.proAccessReason,
      proAccessExpiresAt: params.proAccessExpiresAt,
    });
  }

  return null;
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
