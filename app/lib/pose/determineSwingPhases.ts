import { PhaseFrame, PhaseKey } from "../vision/extractPhaseFrames";

//--------------------------------------------------
// Pose keypoint types
//--------------------------------------------------
export type PoseKeyName =
  | "left_shoulder"
  | "right_shoulder"
  | "left_hip"
  | "right_hip"
  | "left_wrist"
  | "right_wrist"
  | "left_hand"
  | "right_hand";

export interface PoseKeypoint {
  name: PoseKeyName;
  x: number;
  y: number;
  score?: number;
}

export interface PoseFrame extends PhaseFrame {
  keypoints: Partial<Record<PoseKeyName, PoseKeypoint>>;
}

//--------------------------------------------------
export type DetectKeypoints = (frame: PhaseFrame) => Promise<PoseFrame["keypoints"]>;

function getVectorAngle(a: PoseKeypoint | undefined, b: PoseKeypoint | undefined): number {
  if (!a || !b) return 0;
  // 上から見下ろしに強い → sign を安定
  const dy = b.y - a.y;
  const dx = b.x - a.x;
  return Math.atan2(dy, dx);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function normalize(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (max - min === 0) return 0;
  const clamped = Math.min(Math.max(value, min), max);
  return (clamped - min) / (max - min);
}

function distance(a: PoseKeypoint | undefined, b: PoseKeypoint | undefined): number {
  if (!a || !b) return 0;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getRotationDelta(frame: PoseFrame): number {
  const shoulderAngle = getVectorAngle(frame.keypoints.left_shoulder, frame.keypoints.right_shoulder);
  const hipAngle = getVectorAngle(frame.keypoints.left_hip, frame.keypoints.right_hip);
  return Math.abs(shoulderAngle - hipAngle);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getClubHeadPoint(frame: PoseFrame): PoseKeypoint | undefined {
  const candidates = [
    frame.keypoints.left_wrist,
    frame.keypoints.right_wrist,
    frame.keypoints.left_hand,
    frame.keypoints.right_hand,
  ].filter(Boolean) as PoseKeypoint[];

  if (!candidates.length) return undefined;

  // 上方向が負なので最小 y が最も高い点
  return candidates.reduce((min, kp) => (kp.y < min.y ? kp : min));
}

//--------------------------------------------------
// Fake Motion Generator（方式A）
// 実際のポーズ推定前でも確実に 6 phase が成立する
//--------------------------------------------------
export const defaultDetectKeypoints: DetectKeypoints = async (frame) => {
  const t = frame.timestampSec ?? 0;

  // 安定的な fake trajectory
  return {
    left_shoulder: { name: "left_shoulder", x: 300, y: 300 + Math.sin(t) * 5 },
    right_shoulder: { name: "right_shoulder", x: 420, y: 300 + Math.sin(t) * 5 },
    left_hip: { name: "left_hip", x: 310, y: 500 },
    right_hip: { name: "right_hip", x: 430, y: 500 },
    left_wrist: { name: "left_wrist", x: 350, y: 330 - t * 3 + Math.sin(t) * 4 },
    right_wrist: { name: "right_wrist", x: 370, y: 330 - t * 3 + Math.sin(t) * 4 },
  };
};

function computeMotionEnergy(frames: PoseFrame[]): number[] {
  if (frames.length === 0) return [];

  const energies: number[] = [0];

  for (let i = 1; i < frames.length; i += 1) {
    const prev = frames[i - 1];
    const curr = frames[i];
    const motion =
      distance(prev.keypoints.left_shoulder, curr.keypoints.left_shoulder) +
      distance(prev.keypoints.right_shoulder, curr.keypoints.right_shoulder) +
      distance(prev.keypoints.left_hip, curr.keypoints.left_hip) +
      distance(prev.keypoints.right_hip, curr.keypoints.right_hip) +
      distance(prev.keypoints.left_wrist, curr.keypoints.left_wrist) +
      distance(prev.keypoints.right_wrist, curr.keypoints.right_wrist);

    energies.push(motion);
  }

  return energies;
}

// ------------------------------
// Utility: get left wrist X
// ------------------------------
const getLeftWristX = (frame: PoseFrame): number | null =>
  frame.keypoints.left_wrist?.x ?? null;

// ------------------------------
// Utility: forearm angle (elbow → wrist)
// ------------------------------
function getForearmAngle(frame: PoseFrame): number | null {
  const lw = frame.keypoints.left_wrist;
  const le = frame.keypoints.left_elbow;
  if (!lw || !le) return null;
  return Math.atan2(lw.y - le.y, lw.x - le.x);
}

// ------------------------------
// Utility: wrist X motion
// ------------------------------
function wristXMotion(frames: PoseFrame[], i: number): number {
  if (i <= 0 || i >= frames.length) return 99999;
  const a = getLeftWristX(frames[i]);
  const b = getLeftWristX(frames[i - 1]);
  if (a == null || b == null) return 99999;
  return Math.abs(a - b);
}

const getWristY = (frame: PoseFrame): number | null => {
  const wrists = [
    frame.keypoints.left_wrist,
    frame.keypoints.right_wrist,
    frame.keypoints.left_hand,
    frame.keypoints.right_hand,
  ].filter(Boolean) as PoseKeypoint[];
  if (wrists.length) return wrists.reduce((sum, p) => sum + p.y, 0) / wrists.length;
  const shoulders = [frame.keypoints.left_shoulder, frame.keypoints.right_shoulder].filter(Boolean) as PoseKeypoint[];
  if (shoulders.length) return shoulders.reduce((sum, p) => sum + p.y, 0) / shoulders.length;
  return null;
};

const movingAverage = (values: Array<number | null>, window: number): Array<number | null> => {
  const out: Array<number | null> = [];
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = -window; j <= window; j += 1) {
      const v = values[i + j];
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        count += 1;
      }
    }
    out.push(count ? sum / count : values[i]);
  }
  return out;
};

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
};

function detectDownswingIndex(
  frames: PoseFrame[],
  topIndex: number,
  motionEnergy: number[],
  impactIndex: number,
): number {
  const ys = frames.map((f) => getWristY(f));
  const smoothYs = movingAverage(ys, 1);
  const numericYs = smoothYs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const yRange = numericYs.length ? Math.max(...numericYs) - Math.min(...numericYs) : 0;
  const topY = smoothYs[topIndex];
  if (typeof topY !== "number") return Math.min(frames.length - 1, topIndex + 1);

  const motionMedian = median(motionEnergy.filter((v) => Number.isFinite(v)));
  const dyEps = Math.max(2, yRange * 0.02);
  const deltaEps = Math.max(4, yRange * 0.04);
  const motionEps = Math.max(0.5, motionMedian * 0.6);
  const topWindow = Math.min(5, Math.floor(frames.length * 0.15));
  const searchEnd = impactIndex > topIndex ? impactIndex : frames.length - 1;

  for (let i = topIndex + 1; i <= searchEnd; i += 1) {
    const yPrev = smoothYs[i - 1];
    const yCurr = smoothYs[i];
    if (typeof yPrev !== "number" || typeof yCurr !== "number") continue;
    const dy = yCurr - yPrev;
    const deltaFromTop = yCurr - topY;
    const hasMotion = motionEnergy[i] >= motionEps;
    const sustained =
      dy > dyEps &&
      (i + 1 > searchEnd ||
        (() => {
          const yNext = smoothYs[i + 1];
          return typeof yNext === "number" ? yNext - yCurr > -dyEps * 0.5 : true;
        })());

    const isInTopWindow = i <= topIndex + topWindow;
    if (isInTopWindow && deltaFromTop > 0) {
      if (sustained || (deltaFromTop >= deltaEps * 0.3 && hasMotion)) return i;
    } else if (deltaFromTop >= deltaEps && sustained && hasMotion) {
      return i;
    } else if (deltaFromTop > 0 && (sustained || deltaFromTop >= deltaEps * 0.5)) {
      return i;
    }
  }

  return Math.min(frames.length - 1, topIndex + 1);
}

function pickFrame(frames: PoseFrame[], index: number | undefined, fallbackIndex: number): PoseFrame | undefined {
  if (typeof index === "number" && frames[index]) return frames[index];
  return frames[fallbackIndex];
}

export async function attachPoseKeypoints(frames: PhaseFrame[], detectKeypoints: DetectKeypoints): Promise<PoseFrame[]> {
  const poseFrames: PoseFrame[] = [];
  for (const frame of frames) {
    const keypoints = await detectKeypoints(frame);
    poseFrames.push({ ...frame, keypoints });
  }
  return poseFrames;
}

export function determineSwingPhases(poseFrames: PoseFrame[]): PhaseFrame[] {
  if (!poseFrames.length) return [];

  // ==============================================================
  // 1. Address = motionEnergy + wristXMotion のハイブリッド最小
  // ==============================================================
  const motionEnergy = computeMotionEnergy(poseFrames);
  const early = Math.min(20, poseFrames.length);

  let addressIndex = 0;
  let bestAddressScore = 99999;

  for (let i = 1; i < early; i++) {
    const score = motionEnergy[i] * 0.7 + wristXMotion(poseFrames, i) * 0.3;
    if (score < bestAddressScore) {
      bestAddressScore = score;
      addressIndex = i;
    }
  }

  // ==============================================================
  // 2. Top = 正規化した (X, angle) スコアが最大
  // ==============================================================
  let topIndex = 0;
  let bestTopScore = -99999;

  // X のスケールを 0〜1 に、角度を -1〜+1 に正規化
  const maxX = Math.max(...poseFrames.map((f) => getLeftWristX(f) ?? 0));
  const minX = Math.min(...poseFrames.map((f) => getLeftWristX(f) ?? 0));
  const xRange = Math.max(1, maxX - minX);

  for (let i = 0; i < poseFrames.length; i++) {
    const x = getLeftWristX(poseFrames[i]);
    const ang = getForearmAngle(poseFrames[i]);
    if (x == null || ang == null) continue;

    const xn = (x - minX) / xRange;        // 0〜1
    const an = ang / Math.PI;              // -1〜1
    const score = xn * 0.7 + an * 0.3;

    if (score > bestTopScore) {
      bestTopScore = score;
      topIndex = i;
    }
  }

  // ==============================================================
  // 2-A. Backswing = Address → Top の間で X が上昇し始める点
  // ==============================================================
  let backswingIndex = Math.max(addressIndex + 3, Math.floor(topIndex * 0.3)); // fallback 初期値
  let foundBackswing = false;

  for (let i = addressIndex + 1; i < topIndex; i++) {
    const xPrev = getLeftWristX(poseFrames[i - 1]);
    const xNow = getLeftWristX(poseFrames[i]);
    if (xPrev == null || xNow == null) continue;

    // 左手首Xが明確に増加 → バックスイング開始
    if (xNow - xPrev > 5.0) {
      backswingIndex = i;
      foundBackswing = true;
      break;
    }
  }

  // ============================================================
  // 2-B. もし上昇点が見つからなければ、前腕角度変化で補完
  // ============================================================
  if (!foundBackswing) {
    let best = backswingIndex;
    let bestScore = -99999;
    for (let i = addressIndex + 1; i < topIndex; i++) {
      const aPrev = getForearmAngle(poseFrames[i - 1]);
      const aNow = getForearmAngle(poseFrames[i]);
      if (aPrev == null || aNow == null) continue;

      const diff = Math.abs(aNow - aPrev);
      if (diff > bestScore) {
        best = i;
        bestScore = diff;
      }
    }
    backswingIndex = best;
  }

  // ==============================================================
  // 3. Impact = 速度正→負 の符号反転 + |v2|>2 を満たす点
  //    （fallback: 正速度が最大の点）
  // ==============================================================
  let impactIndex = topIndex;
  let maxSpeed = -99999;

  for (let i = topIndex + 2; i < poseFrames.length; i++) {
    const xm2 = getLeftWristX(poseFrames[i - 2]);
    const xm1 = getLeftWristX(poseFrames[i - 1]);
    const x0 = getLeftWristX(poseFrames[i]);
    if (xm2 == null || xm1 == null || x0 == null) continue;

    const v1 = xm1 - xm2; // 過去速度
    const v2 = x0 - xm1;  // 現在速度

    // 明確なインパクト
    if (v1 > 0 && v2 < 0 && Math.abs(v2) > 2) {
      impactIndex = i - 1;
      break;
    }

    if (v1 > maxSpeed) {
      maxSpeed = v1;
      impactIndex = i - 1;
    }
  }

  // ============================================================
  // 4. Downswing = Top直後の下降開始点（y増加 + 動き）
  // ============================================================
  let downswingIndex = detectDownswingIndex(poseFrames, topIndex, motionEnergy, impactIndex);
  if (impactIndex > topIndex && downswingIndex >= impactIndex) {
    downswingIndex = Math.max(topIndex + 1, impactIndex - 1);
  }

  // ==============================================================
  // 5. Finish = フレーム後半 85%〜100% で最も動きが少ない点
  // ==============================================================
  const finishStart = Math.floor(poseFrames.length * 0.85);
  let finishIndex = poseFrames.length - 1;
  let minFinishMotion = 99999;

  for (let i = finishStart; i < poseFrames.length; i++) {
    const m = wristXMotion(poseFrames, i);
    if (m < minFinishMotion) {
      minFinishMotion = m;
      finishIndex = i;
    }
  }

  const orderedIndexes: Record<PhaseKey, number | undefined> = {
    address: addressIndex,
    backswing: backswingIndex,
    top: topIndex,
    downswing: downswingIndex,
    impact: impactIndex,
    finish: finishIndex,
  };

  const ordered: PhaseKey[] = ["address", "backswing", "top", "downswing", "impact", "finish"];
  const defaultIndex = (phase: PhaseKey): number => {
    const pos = Math.max(0, ordered.indexOf(phase)); // 正しい進行
    const spread = Math.floor((pos / Math.max(ordered.length - 1, 1)) * Math.max(poseFrames.length - 1, 0));
    const candidate = orderedIndexes[phase];
    if (typeof candidate === "number" && poseFrames[candidate]) return candidate;
    return spread;
  };

  return (Object.keys(orderedIndexes) as PhaseKey[]).map((phase) => {
    const chosenFrame = pickFrame(poseFrames, orderedIndexes[phase], defaultIndex(phase));
    const baseFrame = chosenFrame ?? poseFrames[poseFrames.length - 1];
    return {
      ...baseFrame,
      id: phase,
      timestampSec: baseFrame.timestampSec,
    } satisfies PhaseFrame;
  });
}
