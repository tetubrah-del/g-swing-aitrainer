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

  // normalized [0,1] (origin: top-left). Smaller y = higher hands.
  // Prefer wrists (club/hands) to avoid body sway confusing top/downswing.
  const wristY = (f: FramePose) => {
    const wrists = [f.pose?.leftWrist, f.pose?.rightWrist].filter(Boolean) as PosePoint[];
    if (wrists.length) return wrists.reduce((sum, p) => sum + p.y, 0) / wrists.length;
    const shoulders = [f.pose?.leftShoulder, f.pose?.rightShoulder].filter(Boolean) as PosePoint[];
    if (shoulders.length) return shoulders.reduce((sum, p) => sum + p.y, 0) / shoulders.length;
    const hips = [f.pose?.leftHip, f.pose?.rightHip].filter(Boolean) as PosePoint[];
    if (hips.length) return hips.reduce((sum, p) => sum + p.y, 0) / hips.length;
    return undefined;
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

  const movingAverage = (values: Array<number | undefined>, window: number): Array<number | undefined> => {
    const out: Array<number | undefined> = [];
    for (let i = 0; i < values.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = -window; j <= window; j++) {
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
    const sortedVals = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sortedVals.length / 2);
    if (sortedVals.length % 2 === 1) return sortedVals[mid];
    return (sortedVals[mid - 1] + sortedVals[mid]) / 2;
  };

  const smoothYs = movingAverage(ys, 1);
  const numericYs = smoothYs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const yRange = numericYs.length ? Math.max(...numericYs) - Math.min(...numericYs) : 0;
  const motionMedian = median(motions.filter((v) => Number.isFinite(v)));

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
  // タメが強い場合、トップ付近が複数フレーム続くことがあるため「最小付近の最後」を採用。
  let top = 0;
  let minY = Infinity;
  const topSearchEnd = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75)));
  smoothYs.slice(0, topSearchEnd + 1).forEach((y, i) => {
    if (y !== undefined && y < minY) {
      minY = y;
      top = i;
    }
  });
  const topEps = Math.max(0.006, yRange * 0.03);
  if (Number.isFinite(minY) && minY !== Infinity) {
    for (let i = topSearchEnd; i >= 0; i--) {
      const y = smoothYs[i];
      if (typeof y === "number" && y <= minY + topEps) {
        top = i;
        break;
      }
    }
  }

  // Backswing: Address以降で手首が上昇し始める最初（yが小さくなる）
  let backswing = address;
  const riseEps = Math.max(0.006, yRange * 0.04);
  for (let i = address + 1; i <= top; i++) {
    const prev = smoothYs[i - 1];
    const curr = smoothYs[i];
    if (prev !== undefined && curr !== undefined && curr < prev - riseEps) {
      backswing = i;
      break;
    }
  }

  // Downswing: top以降で下降（yが増える）に転じた最初
  // ノイズで 1フレームだけ y が増えるケースを避け、累積の増加 + 連続性 + 動きで判定する。
  // タメが長い場合、top付近で静止しているため、初期の下降を検出しやすくする。
  let downswing = top;
  const dyEps = Math.max(0.003, yRange * 0.025); // より小さな閾値で初期下降を検出
  const deltaEps = Math.max(0.006, yRange * 0.04); // より小さな閾値で初期下降を検出
  const motionEps = Math.max(0.001, motionMedian * 0.6); // より小さな閾値で初期下降を検出
  const topY = smoothYs[top];
  const downswingCandidates: Array<{i: number; dy: number; deltaFromTop: number; hasMotion: boolean; sustained: boolean}> = [];
  if (typeof topY === "number") {
    // タメが長い場合を考慮: topから一定範囲内で静止している可能性がある
    // まず、より緩い条件で初期下降を検出し、それをdownswingとして確定する
    let foundInitialDrop = false;
    const topWindow = Math.min(5, Math.floor(sorted.length * 0.15)); // topから15%以内を「タメ期間」とみなす
    for (let i = top + 1; i < sorted.length; i++) {
      const yPrev = smoothYs[i - 1];
      const yCurr = smoothYs[i];
      if (typeof yPrev !== "number" || typeof yCurr !== "number") continue;

      const dy = yCurr - yPrev;
      const deltaFromTop = yCurr - topY;
      const hasMotion = motions[i] >= motionEps;
      const sustained =
        dy > dyEps &&
        (i + 1 >= sorted.length ||
          (() => {
            const yNext = smoothYs[i + 1];
            return typeof yNext === "number" ? yNext - yCurr > -dyEps * 0.5 : true; // より緩い条件
          })());

      downswingCandidates.push({i, dy, deltaFromTop, hasMotion, sustained});

      // タメ期間内（topから近い範囲）での初期下降検出: より緩い条件
      const isInTopWindow = i <= top + topWindow;
      if (!foundInitialDrop && isInTopWindow && deltaFromTop > 0) {
        // タメ期間内では、わずかな下降でも検出
        if (sustained || (deltaFromTop >= deltaEps * 0.3 && hasMotion)) {
          foundInitialDrop = true;
          downswing = i;
          // タメ期間内で初期下降を検出したら、それを確定（より明確な下降を探さない）
          break;
        }
      }

      // タメ期間外での明確な下降: より厳しい条件（すべて満たす）
      if (!isInTopWindow && deltaFromTop >= deltaEps && sustained && hasMotion) {
        downswing = i;
        break;
      }

      // タメ期間外でも、初期下降がまだ見つかっていない場合は、より緩い条件で検出
      if (!foundInitialDrop && !isInTopWindow && deltaFromTop > 0 && (sustained || deltaFromTop >= deltaEps * 0.5)) {
        foundInitialDrop = true;
        downswing = i;
        // 初期下降を検出したら確定（より明確な下降を探さない）
        break;
      }
    }
  } else {
    downswing = Math.min(sorted.length - 1, top + 1);
  }

  // Impact: 手首高さ最大（クラブが最下点付近）をダウンスイング以降で
  let impact = sorted.length - 1;
  let maxY = -Infinity;
  const impactSearchEnd = Math.max(downswing, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9)));
  smoothYs.forEach((y, i) => {
    if (i < downswing || i > impactSearchEnd) return;
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
  const rawIndices = [
    safeIndex(address),
    safeIndex(backswing),
    safeIndex(top),
    safeIndex(downswing),
    safeIndex(impact),
    safeIndex(finish),
  ];
  const ordered = enforceOrder(rawIndices);

  return {
    address: ordered[0],
    backswing: ordered[1],
    top: ordered[2],
    downswing: ordered[3],
    impact: ordered[4],
    finish: ordered[5],
  };
}
