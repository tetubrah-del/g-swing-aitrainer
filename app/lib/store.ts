import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GolfAnalysisRecord } from "@/app/golf/types";

const analyses = new Map<string, GolfAnalysisRecord>();
const STORE_PATH = path.join(os.tmpdir(), "golf-analyses.json");

async function loadFromDisk() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, GolfAnalysisRecord>;
    Object.entries(parsed).forEach(([id, record]) => {
      if (record && typeof record === "object") {
        analyses.set(id, record);
      }
    });
  } catch {
    // ignore missing file
  }
}

const loadPromise = loadFromDisk();

async function persistToDisk() {
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
