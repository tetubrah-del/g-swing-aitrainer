export interface PosePoint {
  x: number;
  y: number;
}

export interface FramePose {
  idx: number;
  pose?: {
    leftShoulder?: PosePoint;
    rightShoulder?: PosePoint;
    leftElbow?: PosePoint;
    rightElbow?: PosePoint;
    leftWrist?: PosePoint;
    rightWrist?: PosePoint;
    leftHip?: PosePoint;
    rightHip?: PosePoint;
    leftKnee?: PosePoint;
    rightKnee?: PosePoint;
    leftAnkle?: PosePoint;
    rightAnkle?: PosePoint;
  };
}

export interface PhaseIndices {
  address: number;
  backswing: number;
  top: number;
  downswing: number;
  impact: number;
  finish: number;
}

export function computePhaseIndices(frames: FramePose[]): PhaseIndices {
  if (!frames.length) {
    return { address: 0, backswing: 0, top: 0, downswing: 0, impact: 0, finish: 0 };
  }

  // idx 昇順を保証
  const sorted = [...frames].sort((a, b) => a.idx - b.idx);

  const refPoint = (f: FramePose): PosePoint | undefined =>
    f.pose?.leftWrist ||
    f.pose?.rightWrist ||
    f.pose?.leftShoulder ||
    f.pose?.rightShoulder ||
    f.pose?.leftHip ||
    f.pose?.rightHip;

  const wristY = (f: FramePose) => {
    const points = [
      f.pose?.leftWrist,
      f.pose?.rightWrist,
      f.pose?.leftShoulder,
      f.pose?.rightShoulder,
      f.pose?.leftHip,
      f.pose?.rightHip,
    ].filter(Boolean) as PosePoint[];
    if (!points.length) return undefined;
    return points.reduce((sum, p) => sum + p.y, 0) / points.length;
  };

  const velocity = (a?: PosePoint, b?: PosePoint) => {
    if (!a || !b) return 0;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  };

  const motions = sorted.map((f, i) =>
    i === 0 ? 0 : velocity(refPoint(sorted[i]), refPoint(sorted[i - 1])),
  );

  // y は画像上方向が小さい値なので、「トップ」は最小 y となる
  const ys = sorted.map((f) => wristY(f));

  const safeIndex = (i: number) => Math.min(sorted.length - 1, Math.max(0, i));

  const enforceOrder = (indices: number[]) => {
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] <= indices[i - 1]) {
        indices[i] = Math.min(sorted.length - 1, indices[i - 1] + 1);
      }
    }
    return indices;
  };

  // Address: 最初0-3フレームで手首移動が最小
  let address = 0;
  if (sorted.length > 1) {
    let minMove = Infinity;
    const limit = Math.min(3, sorted.length - 1);
    for (let i = 1; i <= limit; i++) {
      const move = motions[i];
      if (move < minMove) {
        minMove = move;
        address = i;
      }
    }
  }

  // Top: 手首高さが最小（最高到達点）
  let top = 0;
  let minY = Infinity;
  ys.forEach((y, i) => {
    if (y !== undefined && y < minY) {
      minY = y;
      top = i;
    }
  });

  // Backswing: Address以降で手首が上昇し始める最初（yが小さくなる）
  let backswing = address;
  const riseEps = 0.005;
  for (let i = address + 1; i <= top; i++) {
    const prev = ys[i - 1];
    const curr = ys[i];
    if (prev !== undefined && curr !== undefined && curr < prev - riseEps) {
      backswing = i;
      break;
    }
  }

  // Downswing: top以降で下降（yが増える）に転じた最初
  let downswing = top;
  const fallEps = 0.005;
  for (let i = top + 1; i < sorted.length; i++) {
    const prev = ys[i - 1];
    const curr = ys[i];
    if (prev !== undefined && curr !== undefined && curr > prev + fallEps) {
      downswing = i;
      break;
    }
  }

  // Impact: 手首高さ最大（クラブが最下点付近）をダウンスイング以降で
  let impact = sorted.length - 1;
  let maxY = -Infinity;
  ys.forEach((y, i) => {
    if (i < downswing) return;
    if (y !== undefined && y > maxY) {
      maxY = y;
      impact = i;
    }
  });

  // Finish: 末尾3フレームで速度最小
  let finish = sorted.length - 1;
  if (sorted.length > 1) {
    const tailStart = Math.max(0, sorted.length - 4);
    let minSpeed = Infinity;
    for (let i = tailStart + 1; i < sorted.length; i++) {
      const speed = motions[i];
      if (speed < minSpeed) {
        minSpeed = speed;
        finish = i;
      }
    }
  }

  // 安定性のためインデックスを単調増加に補正
  const ordered = enforceOrder([
    safeIndex(address),
    safeIndex(backswing),
    safeIndex(top),
    safeIndex(downswing),
    safeIndex(impact),
    safeIndex(finish),
  ]);

  return {
    address: ordered[0],
    backswing: ordered[1],
    top: ordered[2],
    downswing: ordered[3],
    impact: ordered[4],
    finish: ordered[5],
  };
}
