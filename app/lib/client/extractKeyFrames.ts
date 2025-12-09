/**
 * 動画を 25〜35 枚の静止画に均等サンプリングして切り出す
 * 端末ローカル処理（Safari 対応）
 */

import { safeSeek } from "../vision/safeSeek";
import type { PhaseFrame } from "../vision/extractFrames";

// 最大キャプチャ幅（4K動画対策）
const MAX_W = 960;

export async function extractKeyFrames(file: File): Promise<PhaseFrame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");

  video.src = url;
  video.crossOrigin = "anonymous";

  await new Promise((resolve) => {
    video.onloadedmetadata = resolve;
  });

  const duration = video.duration;

  if (!duration || duration < 0.2) {
    throw new Error("動画が短すぎてフレーム抽出できません");
  }

  const frameCount = 30; // 固定サンプリング
  const step = duration / frameCount;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  // 動画サイズを縮小する（メモリ使用量、速度、バッテリー消費の最適化）
  const scale = video.videoWidth > MAX_W ? MAX_W / video.videoWidth : 1;
  canvas.width = Math.floor(video.videoWidth * scale);
  canvas.height = Math.floor(video.videoHeight * scale);

  const frames: PhaseFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const t = step * i;
    await safeSeek(video, t);

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

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

