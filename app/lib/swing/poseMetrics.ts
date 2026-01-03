import type { FramePose, PhaseIndices } from "@/app/lib/swing/phases";
import { computePhaseIndices } from "@/app/lib/swing/phases";

type PosePoint = { x: number; y: number };
type PoseFrame = { idx: number; pose?: Record<string, PosePoint | null> };

export type PoseTracePoint = {
  x: number;
  y: number;
  phase: "backswing" | "downswing";
  frameIndex: number;
  timestampSec?: number;
};

export type PoseMetrics = {
  source: "mediapipe";
  phaseIndices: PhaseIndices;
  handTrace: PoseTracePoint[];
  handKeypoints: {
    address?: PosePoint | null;
    top?: PosePoint | null;
    impact?: PosePoint | null;
  };
  metrics: {
    lowerBodyLead?: {
      hipStartIndex?: number | null;
      chestStartIndex?: number | null;
      deltaFrames?: number | null;
      lead?: "lower_body" | "chest" | "unclear";
      threshold?: number | null;
    };
    handVsChest?: {
      handAdvanceNorm?: number | null;
      shoulderRotationDeg?: number | null;
      ratio?: number | null;
      classification?: "hand_first" | "torso_first" | "mixed" | "unclear";
    };
    chestRotationDeg?: number | null;
    headSway?: {
      dx?: number | null;
      dy?: number | null;
      dist?: number | null;
      distNorm?: number | null;
    };
    kneeSway?: {
      dx?: number | null;
      dy?: number | null;
      dist?: number | null;
      distNorm?: number | null;
    };
    spineTiltDeltaDeg?: number | null;
  };
  debug?: {
    frameCount: number;
    poseUsableCount: number;
  };
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const dist = (a?: PosePoint | null, b?: PosePoint | null) => {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

const avgPoint = (a?: PosePoint | null, b?: PosePoint | null): PosePoint | null => {
  if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return a ?? b ?? null;
};

const angleDeltaRad = (a: number, b: number) => {
  const d = b - a;
  const pi = Math.PI;
  return ((d + pi) % (2 * pi) + 2 * pi) % (2 * pi) - pi;
};

const radToDeg = (rad: number) => (rad * 180) / Math.PI;

const readPosePoint = (pose: Record<string, PosePoint | null> | undefined, key: string): PosePoint | null => {
  if (!pose) return null;
  const p = pose[key];
  if (!p || typeof p.x !== "number" || typeof p.y !== "number") return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
};

const shoulderAngle = (pose?: Record<string, PosePoint | null>): number | null => {
  const ls = readPosePoint(pose, "leftShoulder");
  const rs = readPosePoint(pose, "rightShoulder");
  if (!ls || !rs) return null;
  return Math.atan2(rs.y - ls.y, rs.x - ls.x);
};

const shoulderCenter = (pose?: Record<string, PosePoint | null>) =>
  avgPoint(readPosePoint(pose, "leftShoulder"), readPosePoint(pose, "rightShoulder"));

const hipCenter = (pose?: Record<string, PosePoint | null>) =>
  avgPoint(readPosePoint(pose, "leftHip"), readPosePoint(pose, "rightHip"));

const kneeCenter = (pose?: Record<string, PosePoint | null>) =>
  avgPoint(readPosePoint(pose, "leftKnee"), readPosePoint(pose, "rightKnee"));

const shoulderWidth = (pose?: Record<string, PosePoint | null>) =>
  dist(readPosePoint(pose, "leftShoulder"), readPosePoint(pose, "rightShoulder"));

const handPoint = (pose: Record<string, PosePoint | null> | undefined, handedness: "right" | "left") => {
  const lead = handedness === "left" ? readPosePoint(pose, "rightWrist") : readPosePoint(pose, "leftWrist");
  if (lead) return lead;
  const lw = readPosePoint(pose, "leftWrist");
  const rw = readPosePoint(pose, "rightWrist");
  return avgPoint(lw, rw);
};

const trunkTiltDeg = (pose?: Record<string, PosePoint | null>) => {
  const shoulder = shoulderCenter(pose);
  const hip = hipCenter(pose);
  if (!shoulder || !hip) return null;
  const dx = shoulder.x - hip.x;
  const dy = shoulder.y - hip.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const angle = Math.atan2(Math.abs(dx), Math.abs(dy));
  return radToDeg(angle);
};

export function computePoseMetrics(params: {
  poseFrames: PoseFrame[];
  handedness: "right" | "left";
  timestampsSec?: Array<number | undefined>;
}): PoseMetrics | null {
  const { poseFrames, handedness, timestampsSec } = params;
  if (!poseFrames.length) return null;

  const sorted = [...poseFrames].sort((a, b) => a.idx - b.idx);
  const frameCount = sorted.length;
  const phaseIndices = computePhaseIndices(sorted as FramePose[]);
  const safeIndex = (idx: number) => Math.min(frameCount - 1, Math.max(0, Math.floor(idx)));

  const addressIdx = safeIndex(phaseIndices.address);
  const topIdx = safeIndex(phaseIndices.top);
  const downswingIdx = safeIndex(phaseIndices.downswing);
  const impactIdx = safeIndex(phaseIndices.impact);

  const poseAt = (idx: number) => sorted[safeIndex(idx)]?.pose;

  const addressPose = poseAt(addressIdx);
  const topPose = poseAt(topIdx);
  const impactPose = poseAt(impactIdx);

  const addressShoulder = shoulderCenter(addressPose);
  const topShoulder = shoulderCenter(topPose);
  const addressHip = hipCenter(addressPose);
  const topHip = hipCenter(topPose);
  const addressKnee = kneeCenter(addressPose);
  const topKnee = kneeCenter(topPose);

  const baseShoulderWidth = shoulderWidth(addressPose) ?? shoulderWidth(topPose) ?? null;
  const normScale = baseShoulderWidth && Number.isFinite(baseShoulderWidth) ? Math.max(0.001, baseShoulderWidth) : null;

  const headSwayDist = dist(addressShoulder, topShoulder);
  const kneeSwayDist = dist(addressKnee, topKnee);

  const headSway = addressShoulder && topShoulder ? {
    dx: topShoulder.x - addressShoulder.x,
    dy: topShoulder.y - addressShoulder.y,
    dist: headSwayDist,
    distNorm: normScale && headSwayDist != null ? headSwayDist / normScale : null,
  } : undefined;

  const kneeSway = addressKnee && topKnee ? {
    dx: topKnee.x - addressKnee.x,
    dy: topKnee.y - addressKnee.y,
    dist: kneeSwayDist,
    distNorm: normScale && kneeSwayDist != null ? kneeSwayDist / normScale : null,
  } : undefined;

  const shoulderAngleTop = shoulderAngle(topPose);
  const shoulderAngleImpact = shoulderAngle(impactPose);
  const chestRotationDeg =
    shoulderAngleTop != null && shoulderAngleImpact != null
      ? Math.abs(radToDeg(angleDeltaRad(shoulderAngleTop, shoulderAngleImpact)))
      : null;

  const handTop = handPoint(topPose, handedness);
  const handImpact = handPoint(impactPose, handedness);
  const handAdvance = dist(handTop, handImpact);
  const handAdvanceNorm = normScale && handAdvance != null ? handAdvance / normScale : null;

  const rotationNorm = chestRotationDeg != null ? Math.max(0.001, chestRotationDeg / 45) : null;
  const handVsChestRatio =
    handAdvanceNorm != null && rotationNorm != null ? handAdvanceNorm / rotationNorm : null;

  const handVsChestClassification = (() => {
    if (handVsChestRatio == null || !Number.isFinite(handVsChestRatio)) return "unclear";
    if (handVsChestRatio >= 1.25) return "hand_first";
    if (handVsChestRatio <= 0.85) return "torso_first";
    return "mixed";
  })();

  const spineTiltAddress = trunkTiltDeg(addressPose);
  const spineTiltTop = trunkTiltDeg(topPose);
  const spineTiltDeltaDeg =
    spineTiltAddress != null && spineTiltTop != null ? Math.abs(spineTiltTop - spineTiltAddress) : null;

  const lowerBodyLead = (() => {
    const baselineHip = hipCenter(topPose) ?? hipCenter(addressPose);
    const baselineShoulder = shoulderCenter(topPose) ?? shoulderCenter(addressPose);
    if (!baselineHip || !baselineShoulder) return undefined;
    const threshold = normScale ? Math.max(0.012, normScale * 0.12) : 0.02;
    let hipStart: number | null = null;
    let chestStart: number | null = null;
    for (let i = topIdx + 1; i <= impactIdx; i += 1) {
      const pose = poseAt(i);
      if (!pose) continue;
      const hip = hipCenter(pose);
      const shoulder = shoulderCenter(pose);
      const hipMove = dist(hip, baselineHip);
      const chestMove = dist(shoulder, baselineShoulder);
      if (hipStart == null && hipMove != null && hipMove > threshold) hipStart = i;
      if (chestStart == null && chestMove != null && chestMove > threshold) chestStart = i;
      if (hipStart != null && chestStart != null) break;
    }
    let lead: "lower_body" | "chest" | "unclear" = "unclear";
    if (hipStart != null && chestStart != null) {
      lead = hipStart <= chestStart ? "lower_body" : "chest";
    }
    return {
      hipStartIndex: hipStart,
      chestStartIndex: chestStart,
      deltaFrames: hipStart != null && chestStart != null ? hipStart - chestStart : null,
      lead,
      threshold: Number.isFinite(threshold) ? threshold : null,
    };
  })();

  const handTrace: PoseTracePoint[] = [];
  for (let i = addressIdx; i <= impactIdx; i += 1) {
    const pose = poseAt(i);
    if (!pose) continue;
    const hand = handPoint(pose, handedness);
    if (!hand) continue;
    const phase = i <= topIdx ? "backswing" : "downswing";
    handTrace.push({
      x: hand.x,
      y: hand.y,
      phase,
      frameIndex: sorted[i]?.idx ?? i,
      timestampSec: Array.isArray(timestampsSec) ? timestampsSec[i] : undefined,
    });
  }

  const handKeypoints = {
    address: handPoint(addressPose, handedness),
    top: handPoint(topPose, handedness),
    impact: handPoint(impactPose, handedness),
  };

  const poseUsableCount = sorted.filter((f) => !!f.pose).length;

  return {
    source: "mediapipe",
    phaseIndices,
    handTrace,
    handKeypoints,
    metrics: {
      lowerBodyLead,
      handVsChest: {
        handAdvanceNorm: handAdvanceNorm ?? null,
        shoulderRotationDeg: chestRotationDeg ?? null,
        ratio: handVsChestRatio ?? null,
        classification: handVsChestClassification,
      },
      chestRotationDeg: chestRotationDeg ?? null,
      headSway: headSway ?? null,
      kneeSway: kneeSway ?? null,
      spineTiltDeltaDeg: spineTiltDeltaDeg ?? null,
    },
    debug: {
      frameCount,
      poseUsableCount,
    },
  };
}
