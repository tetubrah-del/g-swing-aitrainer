import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProAccessReason, UserAccount } from "@/app/golf/types";
import { attachUserToAnonymousAnalyses } from "@/app/lib/store";

const users = new Map<string, UserAccount>();
const STORE_PATH = path.join(os.tmpdir(), "golf-users.json");

function deriveNicknameFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (!trimmed) return null;
  const local = trimmed.split("@")[0] ?? "";
  const base = (local || trimmed).trim();
  if (!base) return null;
  return base.slice(0, 24);
}

function normalizeNickname(value: unknown, fallbackEmail?: string | null): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) return raw.slice(0, 24);
  return deriveNicknameFromEmail(fallbackEmail ?? null);
}

export function isUserDisabled(user: UserAccount | null | undefined): boolean {
  if (!user) return false;
  return user.isDisabled === true || (typeof user.disabledAt === "number" && user.disabledAt > 0);
}

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, UserAccount>;
    Object.entries(parsed).forEach(([id, value]) => {
      if (!value || typeof value !== "object") return;
      const normalized: UserAccount = {
        userId: value.userId || id,
        email: value.email ?? null,
        nickname: normalizeNickname((value as Record<string, unknown>).nickname, value.email ?? null),
        authProvider: value.authProvider ?? null,
        emailVerifiedAt:
          value.emailVerifiedAt === null || typeof value.emailVerifiedAt === "number" ? value.emailVerifiedAt : null,
        lastLoginAt:
          (value as Record<string, unknown>).lastLoginAt === null ||
          typeof (value as Record<string, unknown>).lastLoginAt === "number"
            ? ((value as Record<string, unknown>).lastLoginAt as number | null)
            : null,
        lastAnalysisAt:
          (value as Record<string, unknown>).lastAnalysisAt === null ||
          typeof (value as Record<string, unknown>).lastAnalysisAt === "number"
            ? ((value as Record<string, unknown>).lastAnalysisAt as number | null)
            : null,
        isDisabled: (value as Record<string, unknown>).isDisabled === true,
        disabledAt:
          (value as Record<string, unknown>).disabledAt === null || typeof (value as Record<string, unknown>).disabledAt === "number"
            ? ((value as Record<string, unknown>).disabledAt as number | null)
            : null,
        disabledReason:
          typeof (value as Record<string, unknown>).disabledReason === "string"
            ? String((value as Record<string, unknown>).disabledReason).slice(0, 200)
            : null,
        createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
        proAccess: value.proAccess === true,
        proAccessReason: value.proAccessReason ?? null,
        proAccessExpiresAt: typeof value.proAccessExpiresAt === "number" ? value.proAccessExpiresAt : null,
        billingProvider: value.billingProvider ?? null,
        stripeCustomerId: value.stripeCustomerId ?? null,
        stripeSubscriptionId: value.stripeSubscriptionId ?? null,
        subscriptionStatus: value.subscriptionStatus ?? null,
        currentPeriodEnd: typeof value.currentPeriodEnd === "number" ? value.currentPeriodEnd : null,
        cancelAtPeriodEnd: typeof value.cancelAtPeriodEnd === "boolean" ? value.cancelAtPeriodEnd : null,
        trialEnd: typeof value.trialEnd === "number" ? value.trialEnd : null,
        plan: value.plan ?? (value.proAccess ? "pro" : value.email ? "free" : "anonymous"),
        freeAnalysisCount: typeof value.freeAnalysisCount === "number" ? value.freeAnalysisCount : 0,
        freeAnalysisResetAt:
          value.freeAnalysisResetAt === null || typeof value.freeAnalysisResetAt === "number"
            ? value.freeAnalysisResetAt
            : null,
        monitorExpiresAt: typeof value.monitorExpiresAt === "number" ? value.monitorExpiresAt : null,
        anonymousIds: Array.isArray(value.anonymousIds) ? value.anonymousIds.filter((v) => typeof v === "string") : [],
      };
      users.set(normalized.userId, normalized);
    });
  } catch {
    // missing file is fine for first run
  }
}

const loadPromise = loadFromDisk();

export async function resetUserStore() {
  await loadPromise;
  users.clear();
  await persistToDisk();
}

async function persistToDisk() {
  const obj = Object.fromEntries(users.entries());
  try {
    await fs.writeFile(STORE_PATH, JSON.stringify(obj), "utf8");
  } catch {
    // ignore write errors in dev
  }
}

export async function getUserById(userId: string): Promise<UserAccount | null> {
  await loadPromise;
  return users.get(userId) ?? null;
}

export async function findUserByEmail(email: string | null | undefined): Promise<UserAccount | null> {
  await loadPromise;
  if (!email) return null;
  const lower = email.toLowerCase();
  for (const user of users.values()) {
    if (user.email && user.email.toLowerCase() === lower) return user;
  }
  return null;
}

export async function findUserByAnonymousId(anonymousUserId: string | null | undefined): Promise<UserAccount | null> {
  await loadPromise;
  if (!anonymousUserId) return null;
  for (const user of users.values()) {
    if (Array.isArray(user.anonymousIds) && user.anonymousIds.includes(anonymousUserId)) return user;
  }
  return null;
}

export async function saveUser(user: UserAccount) {
  await loadPromise;
  users.set(user.userId, user);
  await persistToDisk();
}

export async function updateUserNickname(params: { userId: string; nickname: string | null }) {
  const user = await getUserById(params.userId);
  if (!user) {
    throw new Error("user not found");
  }
  const updated: UserAccount = {
    ...user,
    nickname: normalizeNickname(params.nickname, user.email ?? null),
    updatedAt: Date.now(),
  };
  await saveUser(updated);
  return updated;
}

export async function updateUserLastLoginAt(params: { userId: string; at?: number | null }) {
  const user = await getUserById(params.userId);
  if (!user) return null;
  const at =
    typeof params.at === "number" && Number.isFinite(params.at) ? Math.trunc(params.at) : Date.now();
  const next: UserAccount = {
    ...user,
    lastLoginAt: at,
    updatedAt: Date.now(),
  };
  await saveUser(next);
  return next;
}

export async function updateUserLastAnalysisAt(params: { userId: string; at?: number | null }) {
  const user = await getUserById(params.userId);
  if (!user) return null;
  const at =
    typeof params.at === "number" && Number.isFinite(params.at) ? Math.trunc(params.at) : Date.now();
  const next: UserAccount = {
    ...user,
    lastAnalysisAt: at,
    updatedAt: Date.now(),
  };
  await saveUser(next);
  return next;
}

export async function disableUserAccount(params: { userId: string; reason?: string | null; anonymize?: boolean }) {
  const user = await getUserById(params.userId);
  if (!user) throw new Error("user not found");
  const now = Date.now();
  const reason = typeof params.reason === "string" && params.reason.trim().length ? params.reason.trim().slice(0, 200) : null;
  const anonymize = params.anonymize === true;

  const next: UserAccount = {
    ...user,
    isDisabled: true,
    disabledAt: now,
    disabledReason: reason,
    lastLoginAt: user.lastLoginAt ?? null,
    proAccess: false,
    proAccessReason: null,
    proAccessExpiresAt: null,
    monitorExpiresAt: null,
    plan: user.email ? "free" : "anonymous",
    updatedAt: now,
    ...(anonymize ? { email: null, nickname: null, authProvider: null } : null),
  };
  await saveUser(next);
  return next;
}

export async function enableUserAccount(params: { userId: string }) {
  const user = await getUserById(params.userId);
  if (!user) throw new Error("user not found");
  const now = Date.now();
  const next: UserAccount = {
    ...user,
    isDisabled: false,
    disabledAt: null,
    disabledReason: null,
    updatedAt: now,
  };
  await saveUser(next);
  return next;
}

export async function listUsers(): Promise<UserAccount[]> {
  await loadPromise;
  return Array.from(users.values());
}

export async function upsertGoogleUser(params: {
  googleSub?: string | null;
  email?: string | null;
  anonymousUserId?: string | null;
  nickname?: string | null;
  proAccess?: boolean;
  proAccessReason?: ProAccessReason | null;
  proAccessExpiresAt?: number | null;
}): Promise<UserAccount> {
  await loadPromise;

  const now = Date.now();
  const userId = params.googleSub?.trim() || crypto.randomUUID();
  const existing = (await getUserById(userId)) || (params.email ? await findUserByEmail(params.email) : null);

  const base: UserAccount =
    existing ??
    ({
      userId,
      email: params.email ?? null,
      nickname: normalizeNickname(params.nickname, params.email ?? null),
      authProvider: "google",
      emailVerifiedAt: now,
      lastLoginAt: now,
      lastAnalysisAt: null,
      isDisabled: false,
      disabledAt: null,
      disabledReason: null,
      createdAt: now,
      updatedAt: now,
      proAccess: false,
      proAccessReason: null,
      proAccessExpiresAt: null,
      billingProvider: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: null,
      trialEnd: null,
      plan: params.email ? "free" : "anonymous",
      freeAnalysisCount: 0,
      freeAnalysisResetAt: null,
      monitorExpiresAt: null,
      anonymousIds: [],
    } satisfies UserAccount);

  const anonymousIds = new Set(base.anonymousIds ?? []);
  if (params.anonymousUserId) {
    const owner = await findUserByAnonymousId(params.anonymousUserId);
    if (!owner || owner.userId === base.userId) {
      anonymousIds.add(params.anonymousUserId);
    }
  }

  const nextPlan =
    params.proAccess ?? base.proAccess
      ? "pro"
      : (params.email ?? base.email)
        ? "free"
        : "anonymous";

  const user: UserAccount = {
    ...base,
    email: params.email ?? base.email,
    nickname: normalizeNickname(params.nickname ?? base.nickname, params.email ?? base.email ?? null),
    authProvider: "google",
    emailVerifiedAt: base.emailVerifiedAt ?? now,
    lastLoginAt: now,
    lastAnalysisAt: base.lastAnalysisAt ?? null,
    isDisabled: base.isDisabled ?? false,
    disabledAt: base.disabledAt ?? null,
    disabledReason: base.disabledReason ?? null,
    updatedAt: now,
    proAccess: params.proAccess ?? base.proAccess ?? false,
    proAccessReason: params.proAccessReason ?? base.proAccessReason ?? null,
    proAccessExpiresAt:
      typeof params.proAccessExpiresAt === "number" ? params.proAccessExpiresAt : base.proAccessExpiresAt ?? null,
    plan: nextPlan,
    freeAnalysisCount: base.freeAnalysisCount ?? 0,
    freeAnalysisResetAt: base.freeAnalysisResetAt ?? null,
    monitorExpiresAt:
      params.proAccessReason === "monitor" && typeof params.proAccessExpiresAt === "number"
        ? params.proAccessExpiresAt
        : base.monitorExpiresAt ?? null,
    anonymousIds: Array.from(anonymousIds),
  };

  users.set(user.userId, user);
  await persistToDisk();

  if (params.anonymousUserId) {
    await attachUserToAnonymousAnalyses(params.anonymousUserId, user.userId);
  }

  return user;
}

export async function registerEmailUser(params: {
  email: string;
  nickname?: string | null;
  anonymousUserId?: string | null;
}): Promise<UserAccount> {
  await loadPromise;
  const now = Date.now();
  const normalizedEmail = params.email.trim().toLowerCase();
  const existing = await findUserByEmail(normalizedEmail);

  const base: UserAccount =
    existing ??
    ({
      userId: crypto.randomUUID(),
      email: normalizedEmail,
      nickname: normalizeNickname(params.nickname, normalizedEmail),
      authProvider: "email",
      emailVerifiedAt: now,
      lastLoginAt: now,
      lastAnalysisAt: null,
      isDisabled: false,
      disabledAt: null,
      disabledReason: null,
      createdAt: now,
      updatedAt: now,
      proAccess: false,
      proAccessReason: null,
      proAccessExpiresAt: null,
      billingProvider: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: null,
      trialEnd: null,
      plan: "free",
      freeAnalysisCount: 0,
      freeAnalysisResetAt: null,
      monitorExpiresAt: null,
      anonymousIds: [],
    } satisfies UserAccount);

  const anonymousIds = new Set(base.anonymousIds ?? []);
  if (params.anonymousUserId) {
    const owner = await findUserByAnonymousId(params.anonymousUserId);
    if (!owner || owner.userId === base.userId) {
      anonymousIds.add(params.anonymousUserId);
    }
  }

  const nextPlan = base.plan === "anonymous" ? "free" : base.plan ?? "free";
  const user: UserAccount = {
    ...base,
    email: normalizedEmail,
    nickname: normalizeNickname(params.nickname ?? base.nickname, normalizedEmail),
    authProvider: base.authProvider ?? "email",
    emailVerifiedAt: base.emailVerifiedAt ?? now,
    lastLoginAt: now,
    lastAnalysisAt: base.lastAnalysisAt ?? null,
    isDisabled: base.isDisabled ?? false,
    disabledAt: base.disabledAt ?? null,
    disabledReason: base.disabledReason ?? null,
    updatedAt: now,
    plan: nextPlan,
    anonymousIds: Array.from(anonymousIds),
  };

  users.set(user.userId, user);
  await persistToDisk();

  if (params.anonymousUserId) {
    await attachUserToAnonymousAnalyses(params.anonymousUserId, user.userId);
  }

  return user;
}

export async function grantMonitorAccess(userId: string, expiresAt: number | null) {
  const user = await getUserById(userId);
  if (!user) {
    throw new Error("user not found");
  }
  const now = Date.now();
  const updated: UserAccount = {
    ...user,
    proAccess: true,
    proAccessReason: "monitor",
    proAccessExpiresAt: expiresAt,
    plan: "pro",
    monitorExpiresAt: expiresAt,
    updatedAt: now,
  };
  await saveUser(updated);
}

export async function revokeMonitorAccess(userId: string) {
  const user = await getUserById(userId);
  if (!user) throw new Error("user not found");
  if (user.proAccessReason !== "monitor") return user;
  const now = Date.now();
  const next: UserAccount = {
    ...user,
    proAccess: false,
    proAccessReason: null,
    proAccessExpiresAt: null,
    monitorExpiresAt: null,
    plan: user.email ? "free" : "anonymous",
    updatedAt: now,
  };
  await saveUser(next);
  return next;
}

export async function linkAnonymousIdToUser(userId: string, anonymousUserId: string): Promise<UserAccount | null> {
  const user = await getUserById(userId);
  if (!user) return null;
  const set = new Set(user.anonymousIds ?? []);
  if (set.has(anonymousUserId)) return user;
  const owner = await findUserByAnonymousId(anonymousUserId);
  if (owner && owner.userId !== user.userId) {
    // Don't allow one device anonymousId to be linked to multiple accounts.
    return user;
  }
  set.add(anonymousUserId);
  const next: UserAccount = {
    ...user,
    anonymousIds: Array.from(set),
    updatedAt: Date.now(),
  };
  await saveUser(next);
  await attachUserToAnonymousAnalyses(anonymousUserId, userId);
  return next;
}

export async function incrementFreeAnalysisCount(params: { userId: string }) {
  const user = await getUserById(params.userId);
  if (!user) return;
  const next: UserAccount = {
    ...user,
    freeAnalysisCount: (user.freeAnalysisCount ?? 0) + 1,
    updatedAt: Date.now(),
  };
  await saveUser(next);
}

export async function updateStripeCustomerForUser(params: { userId: string; stripeCustomerId: string }) {
  const user = await getUserById(params.userId);
  if (!user) return null;
  const next: UserAccount = {
    ...user,
    billingProvider: "stripe",
    stripeCustomerId: params.stripeCustomerId,
    updatedAt: Date.now(),
  };
  await saveUser(next);
  return next;
}

export async function updateStripeSubscriptionForUser(params: {
  userId: string;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean | null;
  trialEnd: number | null;
  stripeCustomerId?: string | null;
}) {
  const user = await getUserById(params.userId);
  if (!user) return null;

  const status = params.subscriptionStatus;
  const proActive = status === "active" || status === "trialing" || status === "past_due";
  const proAccessExpiresAt = proActive ? params.currentPeriodEnd : null;

  const next: UserAccount = {
    ...user,
    billingProvider: "stripe",
    stripeCustomerId: params.stripeCustomerId ?? user.stripeCustomerId ?? null,
    stripeSubscriptionId: params.stripeSubscriptionId,
    subscriptionStatus: status,
    currentPeriodEnd: params.currentPeriodEnd,
    cancelAtPeriodEnd: params.cancelAtPeriodEnd,
    trialEnd: params.trialEnd,
    proAccess: proActive,
    proAccessReason: proActive ? "paid" : null,
    proAccessExpiresAt,
    plan: proActive ? "pro" : user.email ? "free" : "anonymous",
    updatedAt: Date.now(),
  };

  await saveUser(next);
  return next;
}
