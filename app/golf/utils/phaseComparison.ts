import type { SwingAnalysis } from "@/app/golf/types";

const PHASE_LABELS: Record<keyof SwingAnalysis["phases"], string> = {
  address: "アドレス",
  backswing: "バックスイング",
  top: "トップ",
  downswing: "ダウンスイング",
  impact: "インパクト",
  finish: "フィニッシュ",
};

const uniq = (items: string[]) => Array.from(new Set(items.map((s) => s.trim()).filter(Boolean)));

const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

const pickFirst = (...candidates: Array<string | undefined | null>) => {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length) return candidate.trim();
  }
  return null;
};

export function buildPhaseComparison(previous: SwingAnalysis, current: SwingAnalysis): NonNullable<SwingAnalysis["comparison"]> {
  const improved: string[] = [];
  const regressed: string[] = [];

  (Object.keys(PHASE_LABELS) as Array<keyof SwingAnalysis["phases"]>).forEach((phaseKey) => {
    const prev = previous.phases?.[phaseKey];
    const cur = current.phases?.[phaseKey];
    if (!prev || !cur) return;

    const delta = (Number(cur.score) || 0) - (Number(prev.score) || 0);

    const prevIssues = uniq(prev.issues ?? []);
    const curIssues = uniq(cur.issues ?? []);
    const removedIssues = diff(prevIssues, curIssues);
    const addedIssues = diff(curIssues, prevIssues);

    const deltaText = delta !== 0 ? `（${delta > 0 ? `+${delta}` : `${delta}`})` : "";
    const label = PHASE_LABELS[phaseKey];

    if (delta > 0 || (delta === 0 && removedIssues.length > 0 && addedIssues.length === 0)) {
      const reason =
        pickFirst(
          removedIssues[0] ? `「${removedIssues[0]}」が改善傾向` : null,
          cur.good?.[0],
          cur.advice?.[0],
        ) ?? "安定してきた";
      improved.push(`${label}${deltaText}: ${reason}`);
      return;
    }

    if (delta < 0 || (delta === 0 && addedIssues.length > 0 && removedIssues.length === 0)) {
      const reason =
        pickFirst(
          addedIssues[0] ? `「${addedIssues[0]}」が目立つ` : null,
          cur.issues?.[0],
          prev.good?.[0] ? `「${prev.good?.[0]}」の再現性が落ちた` : null,
          cur.advice?.[0],
        ) ?? "安定感が落ちた";
      regressed.push(`${label}${deltaText}: ${reason}`);
    }
  });

  return {
    improved: improved.slice(0, 5),
    regressed: regressed.slice(0, 5),
  };
}

