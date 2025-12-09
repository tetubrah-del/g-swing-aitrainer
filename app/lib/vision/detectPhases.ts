/**
 * Motion Energy と動画時系列から 5 フェーズを推定する
 *
 * フェーズ定義：
 * - Address: 動きが最小の初期姿勢
 * - Top: バックスイング側で動きが最大直前の反転点
 * - Downswing: Top 直後の急加速区間のピーク
 * - Impact: 動きピーク（衝突点）
 - Finish: 動きが収束した終端
 */

export interface PhaseIndices {
  address: number;
  top: number;
  downswing: number;
  impact: number;
  finish: number;
}

export function detectPhases(energy: number[]): PhaseIndices {

  // --- 移動平均でノイズ除去 ---
  const smooth = movingAverage(energy, 3);

  const maxIdx = smooth.indexOf(Math.max(...smooth)); // impact
  const minIdx = smooth.indexOf(Math.min(...smooth.slice(0, maxIdx))); // top

  const downswing = Math.max(minIdx + 1, Math.floor((minIdx + maxIdx) / 2));

  // --- address は最初の安定フレーム ---
  const address = findStableStart(smooth);

  return {
    address,
    top: minIdx,
    downswing,
    impact: maxIdx,
    finish: smooth.length - 1,
  };
}

function movingAverage(list: number[], w: number) {
  const out: number[] = [];
  for (let i = 0; i < list.length; i++) {
    let s = 0;
    let c = 0;
    for (let j = -w; j <= w; j++) {
      if (list[i + j] != null) {
        s += list[i + j];
        c++;
      }
    }
    out.push(s / c);
  }
  return out;
}

// 最初の「一定以上動いていない区間」を address とする
function findStableStart(energy: number[]) {
  for (let i = 1; i < 5 && i < energy.length; i++) {
    if (energy[i] < energy[0] * 1.2) return i;
  }
  return 0;
}

