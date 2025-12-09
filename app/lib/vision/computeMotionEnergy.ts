/**
 * 連続フレームの差分量（Motion Energy）で動きの強度を測定する
 */

import type { PhaseFrame } from "./extractFrames";

export async function computeMotionEnergy(frames: PhaseFrame[]): Promise<number[]> {
  const energies: number[] = [];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  let prevImg: ImageData | null = null;

  for (const frame of frames) {
    const imgEl = new Image();
    imgEl.src = `data:${frame.mimeType};base64,${frame.base64Image}`;

    await new Promise((resolve) => (imgEl.onload = resolve));

    canvas.width = imgEl.width;
    canvas.height = imgEl.height;
    ctx.drawImage(imgEl, 0, 0);

    const cur = ctx.getImageData(0, 0, canvas.width, canvas.height);

    if (prevImg) {
      // 1/8 サンプリングで高速化
      let diff = 0;
      const stride = 8 * 4;

      for (let i = 0; i < cur.data.length; i += stride) {
        const d =
          Math.abs(cur.data[i] - prevImg.data[i]) +
          Math.abs(cur.data[i + 1] - prevImg.data[i + 1]) +
          Math.abs(cur.data[i + 2] - prevImg.data[i + 2]);
        diff += d;
      }
      energies.push(diff / 8);
    } else {
      energies.push(0);
    }

    prevImg = cur;
  }

  return energies;
}

