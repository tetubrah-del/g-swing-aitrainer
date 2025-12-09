// app/lib/vision/detectPhases.ts

export interface PhaseDetectionResult {
  address: number;
  top: number;
  downswing: number;
  impact: number;
  finish: number;
}

// motionEnergy 配列からフェーズを推定
export function detectPhases(energies: number[]): PhaseDetectionResult | null {
  if (!energies.length) return null;

  const n = energies.length;

  // address = 最初の低エネルギー
  const address = 0;

  // top = 最初の「ピーク」近辺
  let top = energies.indexOf(Math.max(...energies.slice(0, Math.floor(n * 0.5))));

  if (top < 1) top = Math.floor(n * 0.25);

  // impact = 最大エネルギー点
  const impact = energies.indexOf(Math.max(...energies));

  // downswing = top → impact の中間点
  const downswing = Math.floor((top + impact) / 2);

  // finish = 最後の低エネルギー点
  const finish = n - 1;

  if (!(address < top && top < downswing && downswing < impact && impact < finish)) {
    return null;
  }

  return { address, top, downswing, impact, finish };
}
