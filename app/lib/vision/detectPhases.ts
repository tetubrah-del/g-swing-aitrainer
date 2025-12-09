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

import type { PhaseFrame } from "./extractFrames";

export interface PhaseIndices {
  address: number;
  top: number;
  downswing: number;
  impact: number;
  finish: number;
}

export function detectPhases(frames: PhaseFrame[], energy: number[]): PhaseIndices {
  const n = frames.length;

  // Address = 最初の動きが小さいフレーム
  let address = 0;
  for (let i = 1; i < 5 && i < n; i++) {
    if (energy[i] < energy[address]) address = i;
  }

  // Impact = 全体で最大の動き
  let impact = energy.indexOf(Math.max(...energy));

  // Top = impact の前で最も動きが少ない谷
  let top = 0;
  let minE = Infinity;
  for (let i = 1; i < impact; i++) {
    if (energy[i] < minE) {
      minE = energy[i];
      top = i;
    }
  }

  // Downswing = top 直後〜impact 直前で最も動きが大きい
  let downswing = top + 1;
  let maxD = -1;
  for (let i = top + 1; i < impact; i++) {
    if (energy[i] > maxD) {
      maxD = energy[i];
      downswing = i;
    }
  }

  // Finish = impact 以降で動きが小さくなった後
  let finish = n - 1;
  let minAfter = Infinity;
  for (let i = impact + 1; i < n; i++) {
    if (energy[i] < minAfter) {
      minAfter = energy[i];
      finish = i;
    }
  }

  return { address, top, downswing, impact, finish };
}

