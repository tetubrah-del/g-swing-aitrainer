import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// NOTE: File-based quota store for anonymous users. Not safe for multi-instance production environments.
const STORE_PATH = path.join(os.tmpdir(), "golf-anonymous-quota.json");

const anonymousCounts = new Map<string, number>();

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, number>;
    Object.entries(parsed).forEach(([id, count]) => {
      if (typeof count === "number") anonymousCounts.set(id, count);
    });
  } catch {
    // missing is fine
  }
}

const loadPromise = loadFromDisk();

async function persist() {
  const obj = Object.fromEntries(anonymousCounts.entries());
  try {
    await fs.writeFile(STORE_PATH, JSON.stringify(obj), "utf8");
  } catch {
    // ignore write failure
  }
}

export async function getAnonymousQuotaCount(id: string): Promise<number> {
  await loadPromise;
  return anonymousCounts.get(id) ?? 0;
}

export async function incrementAnonymousQuotaCount(id: string): Promise<number> {
  await loadPromise;
  const next = (anonymousCounts.get(id) ?? 0) + 1;
  anonymousCounts.set(id, next);
  await persist();
  return next;
}

export async function setAnonymousQuotaCount(id: string, value: number): Promise<number> {
  await loadPromise;
  const next = Math.max(0, Math.floor(value));
  if (next <= 0) {
    anonymousCounts.delete(id);
  } else {
    anonymousCounts.set(id, next);
  }
  await persist();
  return next;
}

export async function resetAnonymousQuotaStore(): Promise<void> {
  await loadPromise;
  anonymousCounts.clear();
  await persist();
}
