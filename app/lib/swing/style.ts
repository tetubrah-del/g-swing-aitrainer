export type SwingStyleType = "torso-dominant" | "arm-dominant" | "mixed";
export type ConfidenceLevel = "high" | "medium" | "low";

export type SwingStyleAssessment = {
  type: SwingStyleType;
  confidence: ConfidenceLevel;
  evidence: string[];
};

export type SwingStyleChange = {
  previous: SwingStyleType;
  current: SwingStyleType;
  change: "improving" | "worsening" | "unchanged" | "unclear";
  confidence: ConfidenceLevel;
};

export type SwingStyleFramesInput = {
  top: {
    shoulder_angle: number;
    hand_position: { x: number; y: number };
    shoulder_center?: { x: number; y: number };
    shoulder_width?: number;
  };
  downswing: {
    shoulder_angle: number;
    hand_position: { x: number; y: number };
    shoulder_center?: { x: number; y: number };
    shoulder_width?: number;
  };
  impact: {
    shoulder_angle: number;
    hand_position: { x: number; y: number };
    face_angle?: number | null;
    shoulder_center?: { x: number; y: number };
    shoulder_width?: number;
  };
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const angleDeltaRad = (a: number, b: number) => {
  // normalize to [-pi, pi] delta
  const d = b - a;
  const pi = Math.PI;
  const wrapped = ((d + pi) % (2 * pi) + 2 * pi) % (2 * pi) - pi;
  return wrapped;
};

const dist = (a?: { x: number; y: number }, b?: { x: number; y: number }) => {
  if (!a || !b) return null;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
};

const downgrade = (c: ConfidenceLevel): ConfidenceLevel => {
  if (c === "high") return "medium";
  if (c === "medium") return "low";
  return "low";
};

export function detectSwingStyle(params: {
  frames: SwingStyleFramesInput;
  faceUnstableHint?: boolean;
}): SwingStyleAssessment {
  const { frames } = params;

  // Input is already normalized; if required signals are missing, return mixed with low confidence.
  const required = [
    frames.top.shoulder_angle,
    frames.downswing.shoulder_angle,
    frames.top.hand_position?.x,
    frames.top.hand_position?.y,
    frames.downswing.hand_position?.x,
    frames.downswing.hand_position?.y,
  ];
  if (required.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    return { type: "mixed", confidence: "low", evidence: ["判定に必要な情報が不足"] };
  }

  const shoulderDeltaNorm = Math.abs(angleDeltaRad(frames.top.shoulder_angle, frames.downswing.shoulder_angle)) / Math.PI; // 0..1
  const handDrop = clamp(frames.downswing.hand_position.y - frames.top.hand_position.y, -1, 1);
  const handDropNorm = clamp(handDrop, 0, 1);

  let torsoScore = 0;
  let armScore = 0;
  const evidence: string[] = [];

  // ① rotation lead vs hand drop (Top -> Downswing)
  if (shoulderDeltaNorm >= handDropNorm * 1.15 && shoulderDeltaNorm >= 0.03) {
    torsoScore += 2;
    evidence.push("ダウンスイング初期で胸の回転が先行");
  } else if (handDropNorm >= shoulderDeltaNorm * 1.35 && handDropNorm >= 0.04) {
    armScore += 2;
    evidence.push("ダウンスイング初期で手元の落下が先行");
  } else {
    // no strong vote
  }

  // ② hand-to-torso relationship at downswing
  const shoulderWidth = frames.downswing.shoulder_width ?? null;
  const handDistance = dist(frames.downswing.hand_position, frames.downswing.shoulder_center ?? null);
  if (shoulderWidth && Number.isFinite(shoulderWidth) && shoulderWidth >= 0.03 && handDistance && Number.isFinite(handDistance)) {
    const ratio = handDistance / shoulderWidth;
    const xRatio = frames.downswing.shoulder_center
      ? Math.abs(frames.downswing.hand_position.x - frames.downswing.shoulder_center.x) / shoulderWidth
      : null;

    if (ratio >= 1.3 || (xRatio != null && xRatio >= 0.9)) {
      armScore += 2;
      evidence.push("ダウンスイングで手元が体から離れやすい");
    } else if (ratio <= 1.05) {
      torsoScore += 1;
      evidence.push("手元が胸の回転面内に収まりやすい");
    }
  }

  // Decide type (3-class)
  let type: SwingStyleType = "mixed";
  if (Math.abs(torsoScore - armScore) <= 1) {
    type = "mixed";
  } else if (torsoScore > armScore) {
    type = "torso-dominant";
  } else {
    type = "arm-dominant";
  }

  // Confidence
  let confidence: ConfidenceLevel = "low";
  const hasCriterion1 = evidence.some((e) => e.includes("初期"));
  const hasCriterion2 = evidence.some((e) => e.includes("手元が"));
  const bothAgree =
    (type === "torso-dominant" && torsoScore >= 3 && armScore === 0) ||
    (type === "arm-dominant" && armScore >= 4 && torsoScore === 0);

  if (type === "mixed") {
    confidence = hasCriterion1 || hasCriterion2 ? "low" : "low";
  } else if (bothAgree) {
    confidence = "high";
  } else if (hasCriterion1 || hasCriterion2) {
    confidence = "medium";
  }

  if (params.faceUnstableHint) {
    confidence = downgrade(confidence);
  }

  const trimmedEvidence = evidence.length ? evidence.slice(0, 2) : ["判定が曖昧なためmixed"];
  return { type, confidence, evidence: trimmedEvidence };
}

export function detectSwingStyleChange(params: {
  previous: SwingStyleType | null | undefined;
  current: SwingStyleAssessment;
}): SwingStyleChange {
  const previous = params.previous ?? "mixed";
  const current = params.current.type;

  let change: SwingStyleChange["change"] = "unclear";
  if (previous === "arm-dominant" && current === "torso-dominant") change = "improving";
  else if (previous === "torso-dominant" && current === "arm-dominant") change = "worsening";
  else if (previous === current && previous !== "mixed") change = "unchanged";
  else change = "unclear";

  const baseConfidence = params.current.confidence;
  const confidence: ConfidenceLevel =
    change === "unclear" ? (baseConfidence === "high" ? "medium" : "low") : baseConfidence;

  return { previous, current, change, confidence };
}

export function buildSwingStyleComment(params: {
  assessment: SwingStyleAssessment;
  change: SwingStyleChange;
  scoreDelta?: number | null;
}): string {
  const { assessment, change } = params;

  const improving = change.change === "improving";
  const worsening = change.change === "worsening";
  const unchanged = change.change === "unchanged";
  const unclear = change.change === "unclear";

  const scoreDelta = typeof params.scoreDelta === "number" && Number.isFinite(params.scoreDelta) ? params.scoreDelta : null;
  const scoreNote = improving && (scoreDelta === 0 || scoreDelta === null)
    ? "まだスコアの数値に直結していなくても、"
    : "";

  if (improving) {
    return `前回と比べて、腕主導から胸の回転を使う動きへ移行しています。${scoreNote}スイングの方向性としては良い変化です。`;
  }

  if (worsening) {
    return "前回より腕の動きが先行しやすい傾向です。胸の回転と手元の同調を意識すると、再現性が上がりやすくなります。";
  }

  if (unchanged) {
    return assessment.type === "torso-dominant"
      ? "前回と同じく、胸の回転を使う傾向が出ています。この方向性を保ったまま、インパクトの安定を整えていきましょう。"
      : assessment.type === "arm-dominant"
        ? "前回と同じく、腕の動きが先行しやすい傾向です。胸の回転と同調させる意識で安定しやすくなります。"
        : "前回と同じく、胸と腕の動きが混ざりやすい傾向です。まずは胸の回転と手元の同調を揃える意識が効果的です。";
  }

  if (unclear) {
    return "前回比での判定はまだ曖昧ですが、胸の回転と手元の同調を揃えるほどスイングが安定しやすくなります。";
  }

  // Fallback
  return "胸の回転と手元の同調を揃えるほど、スイング全体が安定しやすくなります。";
}

