// app/lib/vision/computeMotionEnergy.ts

// 差分ベースの motion energy（前フレームとの絶対差分）
export function computeMotionEnergy(prev: ImageData | null, curr: ImageData): number {
  if (!prev) return 0;

  const a = prev.data;
  const b = curr.data;
  let sum = 0;

  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    sum += dr + dg + db;
  }

  return sum / (curr.width * curr.height);
}
