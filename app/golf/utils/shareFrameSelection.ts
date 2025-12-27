export type ManualPhaseIndices = {
  address?: number[] | null;
  backswing?: number[] | null;
  top?: number[] | null;
  downswing?: number[] | null;
  impact?: number[] | null;
  finish?: number[] | null;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const normalizeIndices = (indices: number[], max: number) => {
  const normalized = indices
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .map((n) => clamp(Math.round(n), 1, max));
  return Array.from(new Set(normalized));
};

const first = (arr: number[] | null | undefined) => (Array.isArray(arr) && arr.length ? arr[0] : null);

const take = (arr: number[] | null | undefined, count: number) => {
  if (!Array.isArray(arr) || !arr.length) return [];
  return arr.slice(0, count);
};

const pickUnusedNear = (target: number, used: Set<number>, max: number) => {
  const t = clamp(target, 1, max);
  if (!used.has(t)) return t;
  for (let delta = 1; delta <= max; delta += 1) {
    const up = t + delta;
    if (up <= max && !used.has(up)) return up;
    const down = t - delta;
    if (down >= 1 && !used.has(down)) return down;
  }
  return null;
};

/**
 * Share page frames: 7 frames (AD, BS, TOP, DS x2, IMP, FIN).
 * Indices are 1-based (matching UI selector and stage keyFrameIndices).
 */
export function selectShareFrames(params: {
  allFrames: string[];
  manual?: ManualPhaseIndices | null;
  stageIndices?: number[] | null;
  desiredCount?: number;
}): string[] {
  const desiredCount = params.desiredCount ?? 7;
  const max = Math.max(1, params.allFrames.length || 16);

  const stage = normalizeIndices(Array.isArray(params.stageIndices) ? params.stageIndices : [], max).sort((a, b) => a - b);

  const manualRaw = params.manual ?? null;
  const hasManual =
    !!first(manualRaw?.address) ||
    !!first(manualRaw?.backswing) ||
    !!first(manualRaw?.top) ||
    (Array.isArray(manualRaw?.downswing) && manualRaw.downswing.length > 0) ||
    !!first(manualRaw?.impact) ||
    !!first(manualRaw?.finish);

  const ordered: number[] = [];
  if (hasManual) {
    const ad = first(manualRaw?.address);
    const bs = first(manualRaw?.backswing);
    const top = first(manualRaw?.top);
    const ds = take(manualRaw?.downswing, 2);
    const imp = first(manualRaw?.impact);
    const fin = first(manualRaw?.finish);
    for (const n of [ad, bs, top, ...ds, imp, fin]) {
      if (typeof n === 'number' && Number.isFinite(n)) ordered.push(clamp(Math.round(n), 1, max));
    }
  } else {
    // stageIndices usually contain AD, BS, TOP, DS, IMP, FIN (6). We synthesize DS2 when missing.
    const base = stage.slice();
    if (base.length === 6 && desiredCount >= 7) {
      const ds1 = base[3] ?? null;
      const imp = base[4] ?? null;
      if (typeof ds1 === 'number' && typeof imp === 'number') {
        const used = new Set(base);
        const mid = Math.round((ds1 + imp) / 2);
        const candidate = pickUnusedNear(mid, used, max) ?? pickUnusedNear(ds1 + 1, used, max) ?? pickUnusedNear(imp - 1, used, max);
        if (typeof candidate === 'number') {
          base.splice(4, 0, candidate);
        }
      }
    }
    ordered.push(...base);
  }

  const out: number[] = [];
  const used = new Set<number>();
  for (const n of ordered) {
    if (out.length >= desiredCount) break;
    if (!used.has(n)) {
      used.add(n);
      out.push(n);
    }
  }

  const fillFromIndices = (indices: number[]) => {
    for (const n of indices) {
      if (out.length >= desiredCount) break;
      if (!used.has(n)) {
        used.add(n);
        out.push(n);
      }
    }
  };

  // Fill remaining (if some phases were missing/duplicated)
  fillFromIndices(stage);
  if (out.length < desiredCount) {
    const sequential = Array.from({ length: max }, (_, i) => i + 1);
    fillFromIndices(sequential);
  }

  return out
    .slice(0, desiredCount)
    .map((idx) => params.allFrames[idx - 1])
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
}

