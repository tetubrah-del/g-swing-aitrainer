import fs from "node:fs/promises";
import path from "node:path";
import { GolfAnalysisRecord } from "@/app/golf/types";

const analyses = new Map<string, GolfAnalysisRecord>();
const STORE_PATH =
  process.env.GOLF_STORE_PATH && process.env.GOLF_STORE_PATH.trim().length > 0
    ? process.env.GOLF_STORE_PATH.trim()
    : path.join(process.cwd(), ".data", "golf-analyses.json");

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, GolfAnalysisRecord>;
    Object.entries(parsed).forEach(([id, record]) => {
      if (record && typeof record === "object") {
        const normalized: GolfAnalysisRecord = {
          ...record,
          createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
          userId: "userId" in record ? record.userId : null,
          anonymousUserId: "anonymousUserId" in record ? record.anonymousUserId : null,
        };
        analyses.set(id, normalized);
      }
    });
  } catch {
    // ignore missing file
  }
}

const loadPromise = loadFromDisk();

export async function resetAnalysisStore() {
  await loadPromise;
  analyses.clear();
  await persistToDisk();
}

async function persistToDisk() {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const obj = Object.fromEntries(analyses.entries());
  try {
    await fs.writeFile(STORE_PATH, JSON.stringify(obj), "utf8");
  } catch {
    // ignore write errors in dev
  }
}

export async function saveAnalysis(record: GolfAnalysisRecord) {
  await loadPromise;
  analyses.set(record.id, record);
  await persistToDisk();
}

export async function getAnalysis(id: string) {
  await loadPromise;
  return analyses.get(id) ?? null;
}

export async function listAnalyses(
  identifiers: { userId?: string | null; anonymousUserId?: string | null },
  options?: { limit?: number; order?: "asc" | "desc" }
): Promise<GolfAnalysisRecord[]> {
  await loadPromise;

  const { userId, anonymousUserId } = identifiers;
  const limit = options?.limit ?? 50;
  const order = options?.order ?? "desc";

  const filtered = Array.from(analyses.values()).filter((record) => {
    const belongsToUser =
      (userId && record.userId === userId) || (anonymousUserId && record.anonymousUserId === anonymousUserId);
    return belongsToUser;
  });

  filtered.sort((a, b) => {
    const aTime = typeof a.createdAt === "number" ? a.createdAt : 0;
    const bTime = typeof b.createdAt === "number" ? b.createdAt : 0;
    return order === "asc" ? aTime - bTime : bTime - aTime;
  });

  return filtered.slice(0, limit);
}

export async function countMonthlyAnalyses(
  identifiers: { userId?: string | null; anonymousUserId?: string | null },
  now: number = Date.now()
): Promise<number> {
  await loadPromise;

  const startOfMonth = new Date(now);
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const startTs = startOfMonth.getTime();

  const { userId, anonymousUserId } = identifiers;

  let count = 0;
  analyses.forEach((record) => {
    const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
    if (createdAt < startTs) return;

    const belongsToUser =
      (userId && record.userId === userId) || (anonymousUserId && record.anonymousUserId === anonymousUserId);
    if (belongsToUser) {
      count += 1;
    }
  });

  return count;
}

export async function countAnalysesAllTime(identifiers: { userId?: string | null; anonymousUserId?: string | null }) {
  await loadPromise;

  const { userId, anonymousUserId } = identifiers;
  if (!userId && !anonymousUserId) return 0;

  let count = 0;
  analyses.forEach((record) => {
    const belongsToUser =
      (userId && record.userId === userId) || (anonymousUserId && record.anonymousUserId === anonymousUserId);
    if (belongsToUser) {
      count += 1;
    }
  });

  return count;
}

export async function attachUserToAnonymousAnalyses(anonymousUserId: string, userId: string) {
  await loadPromise;
  let updated = false;

  analyses.forEach((record, id) => {
    // Only attach truly-anonymous records; never steal records already owned by another user.
    if (record.anonymousUserId === anonymousUserId && record.userId == null) {
      analyses.set(id, { ...record, userId });
      updated = true;
    }
  });

  if (updated) {
    await persistToDisk();
  }
}

export async function deleteAnalysesForUser(params: { userId: string; anonymousUserIds?: string[] | null }): Promise<string[]> {
  await loadPromise;
  const anonymousUserIds = Array.isArray(params.anonymousUserIds) ? params.anonymousUserIds.filter((v) => typeof v === "string") : [];
  const anonymousSet = new Set(anonymousUserIds);

  const deleted: string[] = [];
  analyses.forEach((record, id) => {
    const matchesUser = record.userId === params.userId;
    const matchesAnonymous = record.anonymousUserId && anonymousSet.has(record.anonymousUserId);
    if (matchesUser || matchesAnonymous) {
      analyses.delete(id);
      deleted.push(id);
    }
  });

  if (deleted.length > 0) {
    await persistToDisk();
  }
  return deleted;
}
