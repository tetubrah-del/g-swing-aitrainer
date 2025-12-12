'use client';

import { FormEvent, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { GolfAnalysisResponse } from '@/app/golf/types';
import { getLatestReport } from '@/app/golf/utils/reportStorage';
import { computePhaseIndices, type FramePose } from '@/app/lib/swing/phases';

const PHASE_ORDER = [
  'address',
  'backswing',
  'top',
  'downswing',
  'impact',
  'finish',
] as const;

const PHASE_LABELS: Record<PhaseKey, string> = {
  address: 'Address',
  backswing: 'Backswing',
  top: 'Top',
  downswing: 'Downswing',
  impact: 'Impact',
  finish: 'Finish',
};

type PhaseKey = (typeof PHASE_ORDER)[number];

type PhaseFrame = {
  phase: PhaseKey;
  timestamp: number;
  imageBase64: string;
  imageUrl?: string;
};

type PoseKeyName =
  | 'left_shoulder'
  | 'right_shoulder'
  | 'left_hip'
  | 'right_hip'
  | 'left_wrist'
  | 'right_wrist'
  | 'left_hand'
  | 'right_hand'
  | 'left_elbow';

type PoseKeypoint = {
  name: PoseKeyName;
  x: number;
  y: number;
  score?: number;
};

type PoseFrame = {
  timestamp: number;
  imageBase64: string;
  keypoints: Partial<Record<PoseKeyName, PoseKeypoint>>;
};

type RawFrame = {
  timestamp: number;
  imageBase64: string;
  mimeType: string;
  duration: number;
};

type PosePipeline = ((input: string | Blob, options?: Record<string, unknown>) => Promise<unknown>) | null;

type FrameMeta = { url: string; index: number; timestampSec: number };
type PhaseKeypoints = { idx: number; pose?: { leftWrist?: { x: number; y: number }; rightWrist?: { x: number; y: number } } };

// 画像URL配列から動きが異なる代表フレームだけを選ぶためのユーティリティ
async function loadImageData(url: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const targetWidth = 320;
      const scale = img.naturalWidth ? Math.min(1, targetWidth / img.naturalWidth) : 1;
      const w = Math.max(1, Math.round((img.naturalWidth || targetWidth) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || targetWidth) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('canvas context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      try {
        const data = ctx.getImageData(0, 0, w, h);
        resolve(data);
      } catch (err) {
        reject(err instanceof Error ? err : new Error('getImageData failed'));
      }
    };
    img.onerror = () => reject(new Error(`image load failed: ${url}`));
    img.src = url;
  });
}

async function computeMotionEnergiesFromUrls(urls: string[]): Promise<number[]> {
  const energies: number[] = [];
  let prev: ImageData | null = null;

  for (const url of urls) {
    const cur = await loadImageData(url);
    if (prev) {
      let diff = 0;
      const stride = 8 * 4;
      const len = Math.min(prev.data.length, cur.data.length);
      for (let i = 0; i < len; i += stride) {
        const d =
          Math.abs(cur.data[i] - prev.data[i]) +
          Math.abs(cur.data[i + 1] - prev.data[i + 1]) +
          Math.abs(cur.data[i + 2] - prev.data[i + 2]);
        diff += d;
      }
      energies.push(diff / 8);
    } else {
      energies.push(0);
    }
    prev = cur;
  }

  return energies;
}

function pickRepresentativeIndicesByBuckets(energies: number[], bucketCount: number): number[] {
  const n = energies.length;
  if (!n) return [];
  const indices = new Set<number>();
  indices.add(0);
  indices.add(n - 1);

  const bucketSize = Math.max(1, Math.floor(n / bucketCount));
  for (let b = 0; b < bucketCount; b++) {
    const start = b * bucketSize;
    const end = Math.min(n, start + bucketSize);
    if (start >= n) break;
    let bestIdx = start;
    let bestEnergy = -1;
    for (let i = start; i < end; i++) {
      if (energies[i] > bestEnergy) {
        bestEnergy = energies[i];
        bestIdx = i;
      }
    }
    indices.add(bestIdx);
  }

  return Array.from(indices).sort((a, b) => a - b);
}

async function selectRepresentativeFrames(urls: string[], maxFrames = 14, fps = 15): Promise<FrameMeta[]> {
  if (urls.length <= maxFrames) {
    return urls.map((url, index) => ({ url, index, timestampSec: index / fps }));
  }

  const energies = await computeMotionEnergiesFromUrls(urls);
  const bucketCount = Math.min(maxFrames, Math.ceil(urls.length / 2));
  const picked = pickRepresentativeIndicesByBuckets(energies, bucketCount);

  // 中盤の動きが速い区間を厚めに拾う（全体の25%〜75%でエナジー上位を追加）
  const midStart = Math.floor(urls.length * 0.25);
  const midEnd = Math.min(urls.length, Math.ceil(urls.length * 0.75));
  const midExtras = energies
    .map((e, idx) => ({ idx, e }))
    .filter(({ idx }) => idx >= midStart && idx < midEnd)
    .sort((a, b) => b.e - a.e)
    .slice(0, 3)
    .map(({ idx }) => idx);

  // トップ付近（0.35〜0.6）の動きが大きいフレームを追加で拾う
  const topWindowStart = Math.floor(urls.length * 0.35);
  const topWindowEnd = Math.min(urls.length, Math.ceil(urls.length * 0.6));
  const topWindowExtras = energies
    .map((e, idx) => ({ idx, e }))
    .filter(({ idx }) => idx >= topWindowStart && idx < topWindowEnd)
    .sort((a, b) => b.e - a.e)
    .slice(0, 3)
    .map(({ idx }) => idx);

  // Top 用に前寄り(35〜50%)で最小エナジーの静止っぽい1枚を必ず追加
  const topMinStart = Math.floor(urls.length * 0.35);
  const topMinEnd = Math.min(urls.length, Math.ceil(urls.length * 0.55));
  let topMinIdx = topMinStart;
  let topMinEnergy = Number.POSITIVE_INFINITY;
  for (let i = topMinStart; i < topMinEnd; i++) {
    if (energies[i] < topMinEnergy) {
      topMinEnergy = energies[i];
      topMinIdx = i;
    }
  }

  // 終盤20%の動きが大きいものを追加（ダウンスイング〜フィニッシュを確保）
  const tailStart = Math.floor(urls.length * 0.8);
  const tailExtras = energies
    .map((e, idx) => ({ idx, e }))
    .filter(({ idx }) => idx >= tailStart)
    .sort((a, b) => b.e - a.e)
    .slice(0, 3)
    .map(({ idx }) => idx);

  // 均等アンカーで全体をカバー
  const anchorCount = 6;
  const anchors: number[] = [];
  for (let i = 0; i < anchorCount; i++) {
    const pos = i / Math.max(anchorCount - 1, 1);
    anchors.push(Math.min(urls.length - 1, Math.max(0, Math.round(pos * (urls.length - 1)))));
  }

  const priorityList = [
    0,
    topMinIdx,
    ...topWindowExtras,
    ...tailExtras,
    ...midExtras,
    ...picked,
    ...anchors,
    urls.length - 1,
  ];

  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const idx of priorityList) {
    if (idx < 0 || idx >= urls.length) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    ordered.push(idx);
    if (ordered.length >= maxFrames) break;
  }

  return ordered
    .map((idx) => ({ url: urls[idx], index: idx, timestampSec: idx / fps }))
    .slice(0, maxFrames);
}

function computePhaseMappingFromKeypoints(data: { frames?: PhaseKeypoints[] } | undefined, totalFrames: number): VisionPhaseMapping {
  const frames = data?.frames ?? [];
  if (!frames.length) {
    // fallback: evenly spread
    return {
      address: 0,
      backswing: Math.floor(totalFrames * 0.2),
      top: Math.floor(totalFrames * 0.4),
      downswing: Math.floor(totalFrames * 0.6),
      impact: Math.floor(totalFrames * 0.8),
      finish: totalFrames - 1,
    };
  }

  // use computePhaseIndices utility on keypoints
  const mapped: FramePose[] = frames.map((f) => ({
    idx: f.idx,
    pose: {
      leftShoulder: f.pose?.leftShoulder,
      rightShoulder: f.pose?.rightShoulder,
      leftElbow: f.pose?.leftElbow,
      rightElbow: f.pose?.rightElbow,
      leftWrist: f.pose?.leftWrist,
      rightWrist: f.pose?.rightWrist,
      leftHip: f.pose?.leftHip,
      rightHip: f.pose?.rightHip,
      leftKnee: f.pose?.leftKnee,
      rightKnee: f.pose?.rightKnee,
      leftAnkle: f.pose?.leftAnkle,
      rightAnkle: f.pose?.rightAnkle,
    },
  }));
  // normalize sorting by idx
  mapped.sort((a, b) => a.idx - b.idx);
  const indices = computePhaseIndices(mapped);
  return {
    address: indices.address,
    backswing: indices.backswing,
    top: indices.top,
    downswing: indices.downswing,
    impact: indices.impact,
    finish: indices.finish,
  };
}

function stripDataUrl(input: string): { base64: string; mimeType: string } {
  const match = input.match(/^data:(.*?);base64,(.*)$/);
  if (match) {
    return { base64: match[2], mimeType: match[1] || 'image/jpeg' };
  }
  return { base64: input, mimeType: 'image/jpeg' };
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

type ExtractApiResponse = {
  frames: Record<PhaseKey, { timestamp: number; imageBase64: string }>;
};

type VisionPhaseMapping = Record<PhaseKey, number>;

type ExtractedKeypoints = {
  frames: Array<{
    idx: number;
    pose?: {
      leftShoulder?: { x: number; y: number };
      rightShoulder?: { x: number; y: number };
      leftElbow?: { x: number; y: number };
      rightElbow?: { x: number; y: number };
      leftWrist?: { x: number; y: number };
      rightWrist?: { x: number; y: number };
      leftHip?: { x: number; y: number };
      rightHip?: { x: number; y: number };
      leftKnee?: { x: number; y: number };
      rightKnee?: { x: number; y: number };
      leftAnkle?: { x: number; y: number };
      rightAnkle?: { x: number; y: number };
    };
    club?: { shaftVector: [number, number] | null };
  }>;
};

async function computePhaseMappingFromEnergy(urls: string[]): Promise<VisionPhaseMapping> {
  const n = urls.length;
  if (!n) {
    return { address: 0, backswing: 0, top: 0, downswing: 0, impact: 0, finish: 0 };
  }
  // エネルギー計算は使わず、時系列の割合で決め打ち（単調増加を保証）
  const picks: number[] = [];
  const ratios = [0, 0.2, 0.5, 0.75, 0.9, 1]; // address, backswing, top, downswing, impact, finish
  ratios.forEach((r, idx) => {
    const raw = Math.round(r * (n - 1));
    const prev = picks[idx - 1] ?? -1;
    const chosen = Math.min(n - (ratios.length - idx), Math.max(raw, prev + 1));
    picks.push(chosen);
  });

  return {
    address: picks[0],
    backswing: picks[1],
    top: picks[2],
    downswing: picks[3],
    impact: picks[4],
    finish: picks[5],
  };
}

async function runVisionPhaseSelection(frames: FrameMeta[]): Promise<VisionPhaseMapping> {
  const res = await fetch('/api/golf/extract/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ frames }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Vision extract failed');
  }

  const { keypoints } = (await res.json()) as { keypoints: ExtractedKeypoints };
  // If keypoints are missing, fallback to energy-based heuristic
  const hasPose =
    keypoints?.frames?.some((f) => f.pose?.leftWrist || f.pose?.rightWrist) ?? false;

  if (!hasPose) {
    return computePhaseMappingFromEnergy(frames.map((f) => f.url));
  }

  return computePhaseMappingFromKeypoints(keypoints, frames.length);
}

async function fetchFramesFromApi(file: File): Promise<RawFrame[]> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/golf/extract', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'フレーム抽出APIの呼び出しに失敗しました');
  }

  const data = (await res.json()) as ExtractApiResponse;

  return PHASE_ORDER.map((phase) => {
    const frame = data.frames[phase];
    if (!frame) {
      throw new Error('フレーム抽出結果が不正です');
    }

    return {
      timestamp: frame.timestamp,
      imageBase64: frame.imageBase64,
      mimeType: 'image/jpeg',
      duration: 0,
    } satisfies RawFrame;
  });
}

/**
 * 🎯 統合関数：画像 or 動画を RawFrame[] に変換
 */
async function extractFramesFromFile(file: File): Promise<RawFrame[]> {
  // 画像ファイル → 単一フレーム
  if (file.type.startsWith('image/')) {
    const dataUrl = await readFileAsDataUrl(file);
    return [
      {
        timestamp: 0,
        imageBase64: dataUrl,
        mimeType: file.type,
        duration: 0,
      },
    ];
  }

  // 🎦 動画ファイル → サーバーサイド抽出
  if (file.type.startsWith('video/')) {
    return fetchFramesFromApi(file);
  }

  throw new Error(`Unsupported file type: ${file.type}`);
}

function distance(a: PoseKeypoint | undefined, b: PoseKeypoint | undefined): number {
  if (!a || !b) return 0;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function getLeftWristX(frame: PoseFrame): number | null {
  return frame.keypoints.left_wrist?.x ?? null;
}

function getForearmAngle(frame: PoseFrame): number | null {
  const lw = frame.keypoints.left_wrist;
  const le = frame.keypoints.left_elbow;
  if (!lw || !le) return null;
  return Math.atan2(lw.y - le.y, lw.x - le.x);
}

function wristXMotion(frames: PoseFrame[], i: number): number {
  if (i <= 0 || i >= frames.length) return 99999;
  const a = getLeftWristX(frames[i]);
  const b = getLeftWristX(frames[i - 1]);
  if (a == null || b == null) return 99999;
  return Math.abs(a - b);
}

function pickFrame(frames: PoseFrame[], index: number | undefined, fallbackIndex: number): PoseFrame | undefined {
  if (typeof index === 'number' && frames[index]) return frames[index];
  return frames[fallbackIndex];
}

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function determineSwingPhases(poseFrames: PoseFrame[]): PhaseFrame[] {
  if (!poseFrames.length) return [];

  const motionEnergy = computeMotionEnergy(poseFrames);
  const early = Math.min(20, poseFrames.length);

  let addressIndex = 0;
  let bestAddressScore = 99999;

  for (let i = 1; i < early; i++) {
    const score = motionEnergy[i] * 0.7 + wristXMotion(poseFrames, i) * 0.3;
    if (score < bestAddressScore) {
      bestAddressScore = score;
      addressIndex = i;
    }
  }

  let topIndex = 0;
  let bestTopScore = -99999;

  const maxX = Math.max(...poseFrames.map((f) => getLeftWristX(f) ?? 0));
  const minX = Math.min(...poseFrames.map((f) => getLeftWristX(f) ?? 0));
  const xRange = Math.max(1, maxX - minX);

  for (let i = 0; i < poseFrames.length; i++) {
    const x = getLeftWristX(poseFrames[i]);
    const ang = getForearmAngle(poseFrames[i]);
    if (x == null || ang == null) continue;

    const xn = (x - minX) / xRange;
    const an = ang / Math.PI;
    const score = xn * 0.7 + an * 0.3;

    if (score > bestTopScore) {
      bestTopScore = score;
      topIndex = i;
    }
  }

  let backswingIndex = Math.max(addressIndex + 3, Math.floor(topIndex * 0.3));
  let foundBackswing = false;

  for (let i = addressIndex + 1; i < topIndex; i++) {
    const xPrev = getLeftWristX(poseFrames[i - 1]);
    const xNow = getLeftWristX(poseFrames[i]);
    if (xPrev == null || xNow == null) continue;

    if (xNow - xPrev > 5.0) {
      backswingIndex = i;
      foundBackswing = true;
      break;
    }
  }

  if (!foundBackswing) {
    let best = backswingIndex;
    let bestScore = -99999;
    for (let i = addressIndex + 1; i < topIndex; i++) {
      const aPrev = getForearmAngle(poseFrames[i - 1]);
      const aNow = getForearmAngle(poseFrames[i]);
      if (aPrev == null || aNow == null) continue;

      const diff = Math.abs(aNow - aPrev);
      if (diff > bestScore) {
        best = i;
        bestScore = diff;
      }
    }
    backswingIndex = best;
  }

  let impactIndex = topIndex;
  let maxSpeed = -99999;

  for (let i = topIndex + 2; i < poseFrames.length; i++) {
    const xm2 = getLeftWristX(poseFrames[i - 2]);
    const xm1 = getLeftWristX(poseFrames[i - 1]);
    const x0 = getLeftWristX(poseFrames[i]);
    if (xm2 == null || xm1 == null || x0 == null) continue;

    const v1 = xm1 - xm2;
    const v2 = x0 - xm1;

    if (v1 > 0 && v2 < 0 && Math.abs(v2) > 2) {
      impactIndex = i - 1;
      break;
    }

    if (v1 > maxSpeed) {
      maxSpeed = v1;
      impactIndex = i - 1;
    }
  }

  const downswingIndex = Math.floor((topIndex + impactIndex) / 2);

  const finishStart = Math.floor(poseFrames.length * 0.85);
  let finishIndex = poseFrames.length - 1;
  let minFinishMotion = 99999;

  for (let i = finishStart; i < poseFrames.length; i++) {
    const m = wristXMotion(poseFrames, i);
    if (m < minFinishMotion) {
      minFinishMotion = m;
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

  const ordered: PhaseKey[] = ['address', 'backswing', 'top', 'downswing', 'impact', 'finish'];
  const defaultIndex = (phase: PhaseKey): number => {
    const pos = Math.max(0, ordered.indexOf(phase));
    const spread = Math.floor((pos / Math.max(ordered.length - 1, 1)) * Math.max(poseFrames.length - 1, 0));
    const candidate = orderedIndexes[phase];
    if (typeof candidate === 'number' && poseFrames[candidate]) return candidate;
    return spread;
  };

  return ordered.map((phase) => {
    const chosenFrame = pickFrame(poseFrames, orderedIndexes[phase], defaultIndex(phase));
    const baseFrame = chosenFrame ?? poseFrames[poseFrames.length - 1];
    return {
      phase,
      timestamp: baseFrame.timestamp,
      imageBase64: baseFrame.imageBase64,
    } satisfies PhaseFrame;
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function detectPoseKeypoints(frame: RawFrame, detector: PosePipeline): Promise<PoseFrame> {
  const { base64, mimeType } = stripDataUrl(frame.imageBase64);
  let detected: Partial<Record<PoseKeyName, PoseKeypoint>> | null = null;

  if (detector) {
    try {
      const response = (await detector(`data:${mimeType};base64,${base64}`, { threshold: 0.25 })) as
        | { keypoints?: Array<{ x: number; y: number; label?: string }> }
        | Array<{ keypoints?: Array<{ x: number; y: number; label?: string }> }>;

      const predictions = Array.isArray(response) ? response : [response];
      const first = predictions.find((item) => Array.isArray(item.keypoints)) as
        | { keypoints?: Array<{ x: number; y: number; label?: string }> }
        | undefined;

      const keypoints = first?.keypoints;
      if (keypoints && keypoints.length >= 13) {
        const mapIndex: Record<PoseKeyName, number> = {
          left_shoulder: 5,
          right_shoulder: 6,
          left_hip: 11,
          right_hip: 12,
          left_wrist: 9,
          right_wrist: 10,
          left_hand: 9,
          right_hand: 10,
          left_elbow: 7,
        };

        detected = Object.entries(mapIndex).reduce((acc, [name, idx]) => {
          const point = keypoints[idx];
          if (point) {
            acc[name as PoseKeyName] = { name: name as PoseKeyName, x: point.x, y: point.y };
          }
          return acc;
        }, {} as Partial<Record<PoseKeyName, PoseKeypoint>>);
      }
    } catch (error) {
      console.warn('[upload] pose detection failed, fallback motion', error);
    }
  }

  if (!detected) {
    const progress = frame.duration ? frame.timestamp / Math.max(frame.duration, 0.001) : frame.timestamp;
    detected = {
      left_shoulder: { name: 'left_shoulder', x: 300, y: 300 + Math.sin(progress * Math.PI) * 8 },
      right_shoulder: { name: 'right_shoulder', x: 420, y: 300 + Math.sin(progress * Math.PI) * 8 },
      left_hip: { name: 'left_hip', x: 310, y: 500 },
      right_hip: { name: 'right_hip', x: 430, y: 500 },
      left_wrist: { name: 'left_wrist', x: 350 + progress * 160, y: 330 - progress * 80 },
      right_wrist: { name: 'right_wrist', x: 370 + progress * 160, y: 330 - progress * 70 },
      left_elbow: { name: 'left_elbow', x: 340 + progress * 110, y: 380 - progress * 40 },
    };
  }

  return {
    timestamp: frame.timestamp,
    imageBase64: frame.imageBase64,
    keypoints: detected,
  };
}

async function buildPhaseFrames(file: File): Promise<PhaseFrame[]> {
  const raw = await extractFramesFromFile(file); // ← 6枚できている想定

  const PHASES: PhaseKey[] = [
    "address",
    "backswing",
    "top",
    "downswing",
    "impact",
    "finish",
  ];

  return PHASES.map((phase, i) => {
    const f = raw[i] ?? raw[raw.length - 1]; // ▼ 不足時の安全 fallback
    return {
      phase,
      timestamp: f.timestamp,
      imageBase64: f.imageBase64,
      imageUrl: f.imageBase64 ?? f.imageUrl,   // ← 動画抽出に対応
    };
  });
}

const GolfUploadPage = () => {
  const router = useRouter();
  const pathname = usePathname();
  const isBeta = pathname.includes('/golf/upload-beta');

  const [file, setFile] = useState<File | null>(null);
  const [handedness, setHandedness] = useState<'right' | 'left'>('right');
  const [clubType, setClubType] = useState<'driver' | 'iron' | 'wedge'>('driver');

  const [previousReport, setPreviousReport] = useState<GolfAnalysisResponse | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const latest = getLatestReport();
    if (latest) {
      setPreviousReport(latest);
    }
  }, []);

  const onFileSelected = async (selectedFile: File | null) => {
    setFile(selectedFile);
    setError(null);

  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!file) {
      setError('スイングの画像または動画ファイルを選択してください。');
      return;
    }

    try {
      setIsSubmitting(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('handedness', handedness);
    formData.append('clubType', clubType);
    formData.append('mode', isBeta ? 'beta' : 'default');

      if (previousReport) {
        formData.append('previousAnalysisId', previousReport.analysisId);
        formData.append('previousReportJson', JSON.stringify(previousReport.result));
      }

      const res = await fetch('/api/golf/analyze', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '診断APIの呼び出しに失敗しました。');
      }

      const data = (await res.json()) as { analysisId: string };
      if (!data.analysisId) {
        throw new Error('analysisId がレスポンスに含まれていません。');
      }

      router.push(isBeta ? `/golf/result-beta/${data.analysisId}` : `/golf/result/${data.analysisId}`);
    } catch (err: unknown) {
      console.error(err);
      const message = err instanceof Error ? err.message : '予期せぬエラーが発生しました。';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen flex justify-center items-center bg-slate-950 text-slate-50">
      <div className="w-full max-w-4xl rounded-2xl bg-slate-900/70 border border-slate-700 p-6 space-y-6">
        <h1 className="text-2xl font-semibold text-center">
          AIゴルフスイング診断 – アップロード
        </h1>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium">スイング画像 / 動画ファイル</label>
              <input
                type="file"
                accept="image/*,video/*"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  onFileSelected(f);
                }}
                className="block w-full text-sm border border-slate-600 rounded-lg bg-slate-900 px-3 py-2 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-slate-700 file:text-sm file:font-medium hover:file:bg-slate-600"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">利き手</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="handedness"
                    value="right"
                    checked={handedness === 'right'}
                    onChange={() => setHandedness('right')}
                  />
                  右打ち
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="handedness"
                    value="left"
                    checked={handedness === 'left'}
                    onChange={() => setHandedness('left')}
                  />
                  左打ち
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium">クラブ種別</label>
              <select
                value={clubType}
                onChange={(e) => setClubType(e.target.value as typeof clubType)}
                className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              >
                <option value="driver">ドライバー</option>
                <option value="iron">アイアン</option>
                <option value="wedge">ウェッジ</option>
              </select>
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-md bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-700 px-4 py-3 text-sm font-semibold text-slate-900 transition-colors"
          >
            {isSubmitting ? '診断中…' : 'このフレームで診断する'}
          </button>
        </form>
      </div>
    </main>
  );
};

export default GolfUploadPage;
