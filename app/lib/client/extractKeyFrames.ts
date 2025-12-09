/**
 * 動画を 25〜35 枚の静止画に均等サンプリングして切り出す
 * 端末ローカル処理（Safari 対応）
 */

import { safeSeek } from "../vision/safeSeek";
import type { PhaseFrame } from "../vision/extractFrames";

export async function extractKeyFrames(file: File): Promise<PhaseFrame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");

  video.src = url;
  video.crossOrigin = "anonymous";

  await new Promise((resolve) => {
    video.onloadedmetadata = resolve;
  });

  const duration = video.duration;

  const frameCount = 30; // 固定サンプリング
  const step = duration / frameCount;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  const frames: PhaseFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const t = step * i;
    await safeSeek(video, t);

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    const base64 = canvas.toDataURL("image/jpeg").split(",")[1];
    frames.push({
      id: `kf-${i}`,
      base64Image: base64,
      mimeType: "image/jpeg",
      timestampSec: t,
    });
  }

  URL.revokeObjectURL(url);
  return frames;
}

