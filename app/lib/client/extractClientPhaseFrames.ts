import { computeMotionEnergy } from "../vision/computeMotionEnergy";
import { detectPhases } from "../vision/detectPhases";
import { safeSeek } from "../vision/safeSeek";
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

function clampIndex(index: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, index));
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
    await new Promise<void>((resolve, reject) => {
      const onLoadedMetadata = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("Failed to load video metadata"));
      };
      const cleanup = (): void => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onError);
      };
      video.addEventListener("loadedmetadata", onLoadedMetadata);
      video.addEventListener("error", onError);
    });
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

    let previousData: ImageData | null = null;
    const totalSamples = Math.max(DEFAULT_SAMPLE_COUNT, 5);

    for (let i = 0; i < totalSamples; i++) {
      const timestampSec = (i / (totalSamples - 1)) * duration;
      await safeSeek(video, timestampSec);
      sampleCtx.drawImage(video, 0, 0, sampleWidth, sampleHeight);
      const imageData = sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight);
      const energy = computeMotionEnergy(previousData, imageData);
      samples.push({ timestampSec, motionEnergy: energy });
      previousData = imageData;
    }

    const useFallback = shouldFallback(duration, samples);
    const phaseSamples = useFallback ? getFallbackTimestamps(duration) : samples;

    let indices: number[];
    if (useFallback) {
      indices = [0, 1, 2, 3, 4];
    } else {
      const phases = detectPhases(samples.map((sample) => sample.motionEnergy));
      if (phases) {
        indices = [
          phases.address,
          phases.top,
          phases.downswing,
          phases.impact,
          phases.finish,
        ];
      } else {
        const step = Math.max(1, Math.floor(totalSamples / phaseOrder.length));
        indices = [0, step * 1, step * 2, step * 3, totalSamples - 1];
      }
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
      await safeSeek(video, timestampSec);
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
