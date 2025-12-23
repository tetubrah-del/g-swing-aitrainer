export type Frame = Record<string, unknown>;

export function extractSequenceFramesAroundImpact<T extends Frame>(
  allFrames: T[],
  impactIndex: number,
  maxFrames: number = 16
): T[] {
  if (!Array.isArray(allFrames) || allFrames.length === 0) return [];
  const limit = Number.isFinite(maxFrames) ? Math.max(1, Math.floor(maxFrames)) : 16;
  if (allFrames.length <= limit) return allFrames.slice();

  const clampedImpact = Math.min(allFrames.length - 1, Math.max(0, Math.floor(impactIndex)));

  const aroundStart = Math.max(0, clampedImpact - 6);
  const aroundEnd = Math.min(allFrames.length - 1, clampedImpact + 6);

  const picked = new Set<number>();
  for (let i = aroundStart; i <= aroundEnd; i += 1) picked.add(i);

  let left = 0;
  let right = allFrames.length - 1;
  while (picked.size < limit && left <= right) {
    if (!picked.has(left)) picked.add(left);
    if (picked.size >= limit) break;
    if (!picked.has(right)) picked.add(right);
    left += 1;
    right -= 1;
  }

  const indices = Array.from(picked).sort((a, b) => a - b);
  return indices.slice(0, limit).map((idx) => allFrames[idx]);
}

