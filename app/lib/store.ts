import { GolfAnalysisRecord } from "@/app/golf/types";

const analyses = new Map<string, GolfAnalysisRecord>();

export function saveAnalysis(record: GolfAnalysisRecord) {
  analyses.set(record.id, record);
}

export function getAnalysis(id: string) {
  return analyses.get(id) ?? null;
}
