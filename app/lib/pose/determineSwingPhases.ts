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

function getRotationDelta(frame: PoseFrame): number {
  const shoulderAngle = getVectorAngle(frame.keypoints.left_shoulder, frame.keypoints.right_shoulder);
  const hipAngle = getVectorAngle(frame.keypoints.left_hip, frame.keypoints.right_hip);
  return Math.abs(shoulderAngle - hipAngle);
}

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

  const rotations = poseFrames.map(getRotationDelta);
  const clubHeadPoints = poseFrames.map(getClubHeadPoint);
  // fallback を安定化
  const clubHeadYs = clubHeadPoints.map((kp) => kp?.y ?? 9999);
  const motionEnergy = computeMotionEnergy(poseFrames);

  const motionThreshold =
    motionEnergy.reduce((sum, v) => sum + v, 0) / (motionEnergy.length || 1) || 0.1;

  // 1. Address: minimal rotation & low motion in first 10 frames
  const addressRange = Math.min(poseFrames.length, 10);
  let addressIndex = 0;
  let addressScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < addressRange; i += 1) {
    const score = rotations[i] + motionEnergy[i] * 0.1;
    if (score < addressScore) {
      addressScore = score;
      addressIndex = i;
    }
  }

  // 2. Backswing start detection
  const risingWindow = 3;
  let backswingIndex: number | undefined;
  for (let i = addressIndex + risingWindow; i < poseFrames.length; i += 1) {
    const deltas = [] as number[];
    for (let w = risingWindow; w > 0; w -= 1) {
      const current = clubHeadYs[i - w + 1];
      const previous = clubHeadYs[i - w];
      deltas.push(current - previous);
    }

    const rising = deltas.every((delta) => delta < -3);
    const rotationIncreasing = rotations[i] > rotations[i - 1];
    const energetic = motionEnergy[i] > motionThreshold;

    if (rising && rotationIncreasing && energetic) {
      backswingIndex = i - risingWindow + 1;
      break;
    }
  }

  // 3. Top: smallest club head Y after backswing
  const topSearchStart = backswingIndex ?? addressIndex;
  let topIndex = topSearchStart;
  let topScore = Number.POSITIVE_INFINITY;
  for (let i = topSearchStart; i < poseFrames.length; i += 1) {
    const score = clubHeadYs[i] - rotations[i] * 10;
    if (score < topScore) {
      topScore = score;
      topIndex = i;
    }
  }

  // 4. Downswing: first descent after top
  let downswingIndex: number | undefined;
  for (let i = topIndex + 1; i < poseFrames.length; i += 1) {
    if (clubHeadYs[i] > clubHeadYs[i - 1]) {
      downswingIndex = i;
      break;
    }
  }

  // 5. Impact: lowest Y around neutral rotation after downswing
  const impactSearchStart = downswingIndex ?? topIndex;
  let impactIndex = impactSearchStart + 2;
  let impactScore = Number.POSITIVE_INFINITY;
  const rotationMin = Math.min(...rotations);
  const rotationMax = Math.max(...rotations);
  for (let i = impactSearchStart; i < poseFrames.length; i += 1) {
    const rotationCenter = normalize(rotations[i], rotationMin, rotationMax);
    const score = clubHeadYs[i] + rotationCenter * 20;
    if (score < impactScore) {
      impactScore = score;
      impactIndex = i;
    }
  }

  // 6. Finish: stabilized high rotation with low motion
  let finishIndex = poseFrames.length - 1;
  let finishScore = Number.POSITIVE_INFINITY;
  for (let i = impactIndex; i < poseFrames.length; i += 1) {
    const stability = motionEnergy[i] + Math.abs(rotations[i] - rotations[impactIndex]);
    if (stability < finishScore) {
      finishScore = stability;
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

