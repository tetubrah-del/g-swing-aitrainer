import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProAccessReason, UserAccount } from "@/app/golf/types";
import { attachUserToAnonymousAnalyses } from "@/app/lib/store";

const users = new Map<string, UserAccount>();
const STORE_PATH = path.join(os.tmpdir(), "golf-users.json");

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, UserAccount>;
    Object.entries(parsed).forEach(([id, value]) => {
      if (!value || typeof value !== "object") return;
      const normalized: UserAccount = {
        userId: value.userId || id,
        email: value.email ?? null,
        authProvider: value.authProvider ?? null,
        createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
        proAccess: value.proAccess === true,
        proAccessReason: value.proAccessReason ?? null,
        proAccessExpiresAt: typeof value.proAccessExpiresAt === "number" ? value.proAccessExpiresAt : null,
        anonymousIds: Array.isArray(value.anonymousIds) ? value.anonymousIds.filter((v) => typeof v === "string") : [],
      };
      users.set(normalized.userId, normalized);
    });
  } catch {
    // missing file is fine for first run
  }
}

const loadPromise = loadFromDisk();

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

export async function saveUser(user: UserAccount) {
  await loadPromise;
  users.set(user.userId, user);
  await persistToDisk();
}

export async function upsertGoogleUser(params: {
  googleSub?: string | null;
  email?: string | null;
  anonymousUserId?: string | null;
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
      authProvider: "google",
      createdAt: now,
      updatedAt: now,
      proAccess: false,
      proAccessReason: null,
      proAccessExpiresAt: null,
      anonymousIds: [],
    } satisfies UserAccount);

  const anonymousIds = new Set(base.anonymousIds ?? []);
  if (params.anonymousUserId) {
    anonymousIds.add(params.anonymousUserId);
  }

  const user: UserAccount = {
    ...base,
    email: params.email ?? base.email,
    authProvider: "google",
    updatedAt: now,
    proAccess: params.proAccess ?? base.proAccess ?? false,
    proAccessReason: params.proAccessReason ?? base.proAccessReason ?? null,
    proAccessExpiresAt:
      typeof params.proAccessExpiresAt === "number" ? params.proAccessExpiresAt : base.proAccessExpiresAt ?? null,
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
    updatedAt: now,
  };
  await saveUser(updated);
}
