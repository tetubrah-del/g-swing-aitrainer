import { ClientPhaseFrame, SwingPhaseKey } from "./swingPhases";

export interface ExtractClientPhaseFramesOptions {
  /** Source video file selected by user */
  file: File;
  /** Optional max width for JPEG (e.g. 480). Maintain aspect ratio. */
  maxWidth?: number;
}

interface MotionSample {
  timestampSec: number;
  motionEnergy: number;
}

const DEFAULT_SAMPLE_COUNT = 40;
const DEFAULT_MAX_WIDTH = 480;
const JPEG_QUALITY = 0.7;

const phaseOrder: SwingPhaseKey[] = [
  "address",
  "top",
  "downswing",
  "impact",
  "finish",
];

function waitForEvent(target: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onResolve = (): void => {
      cleanup();
      resolve();
    };
    const onReject = (): void => {
      cleanup();
      reject(new Error(`Failed while waiting for ${event}`));
    };

    const cleanup = (): void => {
      target.removeEventListener(event, onResolve);
      target.removeEventListener("error", onReject);
    };

    target.addEventListener(event, onResolve, { once: true });
    target.addEventListener("error", onReject, { once: true });
  });
}

async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (video.currentTime === time) return;
  video.currentTime = time;
  await waitForEvent(video, "seeked");
}

function computeMotionEnergy(
  current: Uint8ClampedArray,
  previous?: Uint8ClampedArray
): number {
  if (!previous || previous.length !== current.length) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < current.length; i += 4) {
    const currentGray = (current[i] + current[i + 1] + current[i + 2]) / 3;
    const prevGray = (previous[i] + previous[i + 1] + previous[i + 2]) / 3;
    sum += Math.abs(currentGray - prevGray);
  }

  const pixelCount = current.length / 4;
  return pixelCount > 0 ? sum / pixelCount : 0;
}

function clampIndex(index: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, index));
}

function findExtremeIndex(
  samples: MotionSample[],
  startRatio: number,
  endRatio: number,
  comparator: (value: number, best: number) => boolean,
  initialValue: number
): number {
  const startIndex = clampIndex(
    Math.floor(samples.length * startRatio),
    0,
    samples.length - 1
  );
  const endIndex = clampIndex(
    Math.ceil(samples.length * endRatio),
    0,
    samples.length - 1
  );

  let bestIndex = startIndex;
  let bestValue = initialValue;

  for (let i = startIndex; i <= endIndex; i++) {
    const value = samples[i]?.motionEnergy ?? initialValue;
    if (comparator(value, bestValue)) {
      bestValue = value;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function detectPhaseIndices(samples: MotionSample[]): number[] | null {
  if (!samples.length) return null;

  const addressIndex = findExtremeIndex(
    samples,
    0,
    0.2,
    (value, best) => value < best,
    Number.POSITIVE_INFINITY
  );

  const topIndex = findExtremeIndex(
    samples,
    0.35,
    0.6,
    (value, best) => value < best,
    Number.POSITIVE_INFINITY
  );

  const impactIndex = findExtremeIndex(
    samples,
    0.4,
    0.8,
    (value, best) => value > best,
    Number.NEGATIVE_INFINITY
  );

  const finishIndex = findExtremeIndex(
    samples,
    0.8,
    1,
    (value, best) => value < best,
    Number.POSITIVE_INFINITY
  );

  const downswingIndex = clampIndex(
    Math.round((topIndex + impactIndex) / 2),
    Math.min(topIndex, impactIndex),
    Math.max(topIndex, impactIndex)
  );

  return [addressIndex, topIndex, downswingIndex, impactIndex, finishIndex];
}

function shouldFallback(duration: number, samples: MotionSample[]): boolean {
  if (!Number.isFinite(duration) || duration < 1 || samples.length === 0) {
    return true;
  }
  const energies = samples.map((sample) => sample.motionEnergy);
  const maxEnergy = Math.max(...energies);
  const minEnergy = Math.min(...energies);
  return !Number.isFinite(maxEnergy) || maxEnergy - minEnergy < 1e-3;
}

function getFallbackTimestamps(duration: number): MotionSample[] {
  const ratios = [0.05, 0.35, 0.55, 0.75, 0.95];
  return ratios.map((ratio) => ({
    timestampSec: Math.min(duration, duration * ratio),
    motionEnergy: 0,
  }));
}

function stripDataUrlPrefix(dataUrl: string): string {
  const [, base64 = ""] = dataUrl.split(",");
  return base64;
}

export async function extractClientPhaseFrames(
  options: ExtractClientPhaseFramesOptions
): Promise<ClientPhaseFrame[]> {
  const { file, maxWidth = DEFAULT_MAX_WIDTH } = options;

  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = objectUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.position = "fixed";
  video.style.left = "-9999px";
  video.style.top = "-9999px";
  document.body.appendChild(video);

  const samples: MotionSample[] = [];
  let sampleCanvas: HTMLCanvasElement | null = null;
  let captureCanvas: HTMLCanvasElement | null = null;

  try {
    await waitForEvent(video, "loadedmetadata");
    const duration = video.duration;

    const sampleWidth = 160;
    const sampleHeight = Math.max(
      1,
      Math.round((sampleWidth * video.videoHeight) / Math.max(video.videoWidth, 1))
    );

    sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = sampleWidth;
    sampleCanvas.height = sampleHeight;
    const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!sampleCtx) {
      throw new Error("Failed to create canvas context for sampling");
    }

    let previousData: Uint8ClampedArray | undefined;
    const totalSamples = Math.max(DEFAULT_SAMPLE_COUNT, 5);

    for (let i = 0; i < totalSamples; i++) {
      const timestampSec = (i / (totalSamples - 1)) * duration;
      await seekTo(video, timestampSec);
      sampleCtx.drawImage(video, 0, 0, sampleWidth, sampleHeight);
      const imageData = sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight);
      const energy = computeMotionEnergy(imageData.data, previousData);
      samples.push({ timestampSec, motionEnergy: energy });
      previousData = new Uint8ClampedArray(imageData.data);
    }

    const useFallback = shouldFallback(duration, samples);
    const phaseSamples = useFallback
      ? getFallbackTimestamps(duration)
      : samples;

    const indices = useFallback ? [0, 1, 2, 3, 4] : detectPhaseIndices(phaseSamples);
    if (!indices || indices.length !== phaseOrder.length) {
      return [];
    }

    const captureWidth = Math.min(maxWidth, Math.max(1, video.videoWidth));
    const captureHeight = Math.max(
      1,
      Math.round((captureWidth * video.videoHeight) / Math.max(video.videoWidth, 1))
    );
    captureCanvas = document.createElement("canvas");
    captureCanvas.width = captureWidth;
    captureCanvas.height = captureHeight;
    const captureCtx = captureCanvas.getContext("2d");
    if (!captureCtx) {
      throw new Error("Failed to create canvas context for capture");
    }

    const frames: ClientPhaseFrame[] = [];
    for (let i = 0; i < phaseOrder.length; i++) {
      const phase = phaseOrder[i];
      const sampleIndex = clampIndex(indices[i] ?? 0, 0, phaseSamples.length - 1);
      const timestampSec = phaseSamples[sampleIndex]?.timestampSec ?? 0;
      await seekTo(video, timestampSec);
      captureCtx.drawImage(video, 0, 0, captureWidth, captureHeight);
      const dataUrl = captureCanvas.toDataURL("image/jpeg", JPEG_QUALITY);
      frames.push({
        id: `${phase}-${timestampSec.toFixed(3)}`,
        phase,
        base64Image: stripDataUrlPrefix(dataUrl),
        mimeType: "image/jpeg",
        timestampSec,
      });
    }

    return frames;
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    if (video.parentNode) {
      video.parentNode.removeChild(video);
    }
    if (sampleCanvas) {
      sampleCanvas.width = 0;
      sampleCanvas.height = 0;
    }
    if (captureCanvas) {
      captureCanvas.width = 0;
      captureCanvas.height = 0;
    }
  }
}
