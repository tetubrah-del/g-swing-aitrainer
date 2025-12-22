import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type FreeCoachUsage = {
  usedAt: number;
};

type StoreShape = Record<string, FreeCoachUsage>;

const STORE_PATH = path.join(os.tmpdir(), "golf-free-coach-usage.json");
const memory = new Map<string, FreeCoachUsage>();

let loaded = false;
let loadPromise: Promise<void> | null = null;

async function loadFromDisk() {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await fs.readFile(STORE_PATH, "utf8");
      const parsed = JSON.parse(raw) as StoreShape;
      Object.entries(parsed).forEach(([key, value]) => {
        if (value && typeof value === "object" && typeof value.usedAt === "number") {
          memory.set(key, { usedAt: value.usedAt });
        }
      });
    } catch {
      // ignore missing file
    } finally {
      loaded = true;
      loadPromise = null;
    }
  })();
  return loadPromise;
}

async function persistToDisk() {
  const obj: StoreShape = Object.fromEntries(memory.entries());
  try {
    await fs.writeFile(STORE_PATH, JSON.stringify(obj), "utf8");
  } catch {
    // ignore write errors in dev
  }
}

export function freeCoachUsageKey(params: { actorId: string; analysisId: string }) {
  return `${params.actorId}:${params.analysisId}`;
}

export async function hasFreeCoachUsed(params: { actorId: string; analysisId: string }): Promise<boolean> {
  await loadFromDisk();
  return memory.has(freeCoachUsageKey(params));
}

export async function markFreeCoachUsed(params: { actorId: string; analysisId: string; now?: number }): Promise<void> {
  await loadFromDisk();
  const key = freeCoachUsageKey(params);
  if (memory.has(key)) return;
  memory.set(key, { usedAt: params.now ?? Date.now() });
  await persistToDisk();
}

