'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GolfAnalysisResponse } from '@/app/golf/types';
import { getLatestReport } from '@/app/golf/utils/reportStorage';

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

const loadPoseDetector = () => {
  // 応急処置：Xenova transformers のロードを完全に無効化
  // fallback モーション推定のみ使用してエラーなく Frame 抽出を通す
  return Promise.resolve(null);
};

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

/**
 * 🎯 各ブラウザで必ず動く「安全なフレーム抽出関数」
 * - Safari / iOS / Chrome / Firefox すべて動作
 * - play → pause → seek の最適順序
 * - seeked が発火しない場合に timeout fallback 実行
 */
async function captureFrameAt(videoEl: HTMLVideoElement, ts: number): Promise<string> {
  // ▼ Step 1: Safari/iOS のために decode パイプラインを開始
  if (videoEl.readyState < 2) {
    try {
      await videoEl.play();
    } catch (_) {}

    // Safari は play → small delay → pause の順が一番安定
    await new Promise((r) => setTimeout(r, 30));
    try { videoEl.pause(); } catch (_) {}
  }

  return new Promise((resolve, reject) => {
    let finished = false;

    const cleanup = () => {
      videoEl.onseeked = null;
      videoEl.onerror = null;
    };

    const finalize = () => {
      if (finished) return;
      finished = true;

      cleanup();

      try {
        videoEl.pause();
      } catch (_) {}

      const canvas = document.createElement("canvas");
      canvas.width = videoEl.videoWidth || 640;
      canvas.height = videoEl.videoHeight || 360;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(videoEl, 0, 0);

      resolve(canvas.toDataURL("image/jpeg"));
    };

    videoEl.onerror = () => {
      if (!finished) {
        finished = true;
        cleanup();
        reject(new Error("Video seek error"));
      }
    };

    videoEl.onseeked = () => {
      finalize();
    };

    // ▼ Timeout fallback
    setTimeout(() => {
      if (!finished) {
        console.warn("⚠ seek timeout → fallback frame used");
        finalize();  // cleanup 内蔵
      }
    }, 1500);

    // Safari は seek 前に pause が必要なケースがある
    try {
      videoEl.pause();
    } catch (_) {}

    // ▼ Step 2: currentTime を最後に設定
    try {
      videoEl.currentTime = ts;
    } catch (err) {
      console.warn("⚠ failed to set currentTime → fallback frame used");
      finalize();
    }
  });
}

/**
 * 🎦 動画 → RawFrame[] へ変換
 * - 6フェーズ用の代表フレームだけを抽出
 */
async function extractFramesFromVideo(file: File): Promise<RawFrame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.crossOrigin = 'anonymous';

  await new Promise<void>((resolve) => {
    video.onloadedmetadata = () => resolve();
  });
  // decode pipeline を開始しておく（Safari 対策）
  try {
    await video.play();
  } catch (_) {}
  try {
    video.pause();
  } catch (_) {}

  const duration = video.duration || 1; // 安全のため最低1秒扱い

  // Timing map（必要に応じ調整可能）
  const timestamps = {
    address: 0,
    backswing: duration * 0.05,
    top: duration * 0.45,
    downswing: duration * 0.6,
    impact: duration * 0.68,
    finish: duration * 0.9,
  };

  const results: RawFrame[] = [];

  for (const key in timestamps) {
    const ts = timestamps[key as keyof typeof timestamps];
    const frame = await captureFrameAt(video, ts);
    results.push({
      timestamp: ts,
      imageBase64: frame,
      mimeType: 'image/jpeg',
      duration,
    });
  }

  return results;
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

  // 🎦 動画ファイル → 正しい6フェーズ抽出ロジックに委譲
  if (file.type.startsWith('video/')) {
    return extractFramesFromVideo(file);
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
    };
  });
}

const GolfUploadPage = () => {
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [handedness, setHandedness] = useState<'right' | 'left'>('right');
  const [clubType, setClubType] = useState<'driver' | 'iron' | 'wedge'>('driver');
  const [level, setLevel] = useState<
    'beginner' | 'beginner_plus' | 'intermediate' | 'upper_intermediate' | 'advanced'
  >('intermediate');

  const [previousReport, setPreviousReport] = useState<GolfAnalysisResponse | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phaseFrames, setPhaseFrames] = useState<PhaseFrame[]>([]);

  useEffect(() => {
    const latest = getLatestReport();
    if (latest) {
      setPreviousReport(latest);
    }
  }, []);

  useEffect(() => {
    if (!file) {
      setPhaseFrames([]);
      return;
    }

    setIsExtracting(true);
    buildPhaseFrames(file)
      .then((frames) => setPhaseFrames(frames))
      .catch((err) => {
        console.error(err);
        setError(err instanceof Error ? err.message : 'フレーム抽出に失敗しました');
        setPhaseFrames([]);
      })
      .finally(() => setIsExtracting(false));
  }, [file]);

  const orderedPhaseFrames = useMemo(
    () => PHASE_ORDER.map((phase) => phaseFrames.find((f) => f.phase === phase)).filter(Boolean) as PhaseFrame[],
    [phaseFrames],
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!file) {
      setError('スイングの画像または動画ファイルを選択してください。');
      return;
    }

    if (isExtracting) {
      setError('フレーム抽出完了までお待ちください。');
      return;
    }

    try {
      setIsSubmitting(true);

      const formData = new FormData();
      formData.append('file', file);
      formData.append('handedness', handedness);
      formData.append('clubType', clubType);
      formData.append('level', level);

      if (previousReport) {
        formData.append('previousAnalysisId', previousReport.analysisId);
        formData.append('previousReportJson', JSON.stringify(previousReport.result));
      }

      if (orderedPhaseFrames.length) {
        formData.append('phaseFramesJson', JSON.stringify(orderedPhaseFrames));
        orderedPhaseFrames.forEach((frame) => {
          formData.append('phaseFrames[]', frame.imageBase64);
        });
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

      router.push(`/golf/result/${data.analysisId}`);
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
                  setFile(f);
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

            <div className="space-y-2">
              <label className="block text-sm font-medium">現在のレベル感</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value as typeof level)}
                className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              >
                <option value="beginner">初心者</option>
                <option value="beginner_plus">初級</option>
                <option value="intermediate">中級</option>
                <option value="upper_intermediate">中上級</option>
                <option value="advanced">上級</option>
              </select>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">抽出された6フェーズ（デバッグ用）</p>
                <p className="text-xs text-slate-400">
                  動画読み込み後に Address → Finish までの代表フレームを自動抽出します。
                </p>
              </div>
              <span className="text-xs px-3 py-1 rounded-full border border-emerald-500/60 text-emerald-200">
                {isExtracting ? '解析中…' : '準備完了'}
              </span>
            </div>

            {orderedPhaseFrames.length === 0 && (
              <p className="text-sm text-slate-400">ファイル選択後にプレビューがここに表示されます。</p>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {orderedPhaseFrames.map((frame) => (
                <div key={frame.phase} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-300">
                    <span className="font-semibold">{PHASE_LABELS[frame.phase]}</span>
                    <span>{frame.timestamp.toFixed(2)}s</span>
                  </div>
                  <div className="aspect-video w-full overflow-hidden rounded-md border border-slate-800 bg-slate-900">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={frame.imageBase64} alt={`${frame.phase} frame`} className="h-full w-full object-cover" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting || isExtracting}
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
