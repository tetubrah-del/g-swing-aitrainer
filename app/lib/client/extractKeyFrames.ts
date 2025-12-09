// Safari 完全対応版 動画フェーズ抽出ユーティリティ

export interface ExtractedFrame {
  id: string;
  base64: string;
  mimeType: string;
  timestamp: number;
}

// -----------------------------
// Safari 用 seek 対応ユーティリティ
// -----------------------------
async function waitForEvent(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      target.removeEventListener(event, handler);
      resolve();
    };
    target.addEventListener(event, handler);
  });
}

// Safari の seeked 不発バグを回避する safeSeek
async function safeSeek(video: HTMLVideoElement, t: number): Promise<void> {
  video.currentTime = t;

  // iOS Safari 対策：再生 → 即停止で seek の内部状態を進めさせる
  try {
    const p = video.play();
    if (p !== undefined) {
      await p.catch(() => {});
    }
    video.pause();
  } catch {}

  // seeked を待つ（最大 800ms）
  await Promise.race([
    waitForEvent(video, "seeked"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("seek timeout(safari)")), 800)
    ),
  ]);
}

// -----------------------------
// Motion Energy 計算
// -----------------------------
function computeMotionEnergy(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): number {
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  let sum = 0;
  for (let i = 0; i < data.length; i += 4 * 8) {
    sum += data[i] + data[i + 1] + data[i + 2];
  }
  return sum / (w * h);
}

// -----------------------------
// フェーズ抽出のメイン処理
// -----------------------------
export async function extractKeyFramesFromVideo(
  file: File
): Promise<ExtractedFrame[]> {
  const url = URL.createObjectURL(file);

  const video = document.createElement("video");
  video.src = url;
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;

  await waitForEvent(video, "loadedmetadata");

  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) {
    throw new Error("無効な動画です");
  }

  // -----------------------------
  // 動的に sampleCanvas サイズを決める
  // -----------------------------
  const sampleW = Math.min(200, Math.floor(video.videoWidth / 10) || 160);
  const sampleH = Math.floor((video.videoHeight / video.videoWidth) * sampleW);

  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = sampleW;
  sampleCanvas.height = sampleH;
  const sampleCtx = sampleCanvas.getContext("2d")!;

  // -----------------------------
  // time grid を生成 → motionEnergy 配列を作成
  // -----------------------------
  const sampleCount = 60;
  const times = Array.from({ length: sampleCount }, (_, i) =>
    (duration * i) / (sampleCount - 1)
  );

  const energies: number[] = [];

  for (const t of times) {
    await safeSeek(video, t);
    sampleCtx.drawImage(video, 0, 0, sampleW, sampleH);
    energies.push(computeMotionEnergy(sampleCtx, sampleW, sampleH));
  }

  const minEnergy = Math.min(...energies);
  const maxEnergy = Math.max(...energies);

  // エネルギー幅が小さすぎる → 動きがない動画 → fallback
  if (maxEnergy - minEnergy < 1e-3) {
    console.warn("motion energy too small → only address frame");
    const fallbackTimestamp = times[0];
    await safeSeek(video, fallbackTimestamp);

    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = video.videoWidth;
    captureCanvas.height = video.videoHeight;
    const capCtx = captureCanvas.getContext("2d")!;

    capCtx.drawImage(video, 0, 0);

    const base64 = captureCanvas.toDataURL("image/jpeg", 0.9).split(",")[1];
    URL.revokeObjectURL(url);
    return [
      {
        id: "address",
        base64,
        mimeType: "image/jpeg",
        timestamp: fallbackTimestamp,
      },
    ];
  }

  const maxIndex = energies.indexOf(maxEnergy);
  const minIndex = energies.indexOf(minEnergy);

  const addressIndex = Math.min(maxIndex, minIndex);
  const finishIndex = Math.max(maxIndex, minIndex);

  if (addressIndex >= finishIndex) {
    console.warn("phase index inconsistent → fallback to simple sampling");
  }

  const topIndex = Math.floor(addressIndex * 0.6);
  const impactIndex = Math.floor(addressIndex * 1.2);
  const downswingIndex = Math.floor((topIndex + impactIndex) / 2);

  const phaseIndices = [
    { id: "address", idx: addressIndex },
    { id: "top", idx: topIndex },
    { id: "downswing", idx: downswingIndex },
    { id: "impact", idx: impactIndex },
    { id: "finish", idx: finishIndex },
  ];

  // -----------------------------
  // 各フェーズを実際に seek → capture
  // -----------------------------
  const captureCanvas = document.createElement("canvas");
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  const capCtx = captureCanvas.getContext("2d")!;

  const frames: ExtractedFrame[] = [];

  for (const p of phaseIndices) {
    const t = times[p.idx] ?? 0;
    await safeSeek(video, t);

    capCtx.drawImage(video, 0, 0);
    const b64 = captureCanvas.toDataURL("image/jpeg", 0.9).split(",")[1];

    frames.push({
      id: p.id,
      base64: b64,
      mimeType: "image/jpeg",
      timestamp: t,
    });
  }

  URL.revokeObjectURL(url);
  return frames;
}
