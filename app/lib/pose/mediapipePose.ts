import "server-only";

import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";

import type { ExtractedPoseFrame } from "@/app/lib/vision/extractPoseKeypoints";

type PosePoint = { x: number; y: number };
type RoiRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
};

const LANDMARK_INDEX: Record<string, number> = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

const MODEL_URL =
  process.env.MEDIAPIPE_POSE_MODEL_URL ??
  "https://storage.googleapis.com/mediapipe-assets/pose_landmarker_full.task";

const MODEL_CACHE_PATH = path.join(os.tmpdir(), "mediapipe_pose_landmarker_full.task");

let landmarkerPromise: Promise<unknown> | null = null;
let imageLandmarkerPromise: Promise<unknown> | null = null;
let lowConfidenceImageLandmarkerPromise: Promise<unknown> | null = null;

const DETECTION_CONFIDENCE = Number(process.env.MEDIAPIPE_POSE_MIN_DETECTION_CONFIDENCE ?? "0.3");
const PRESENCE_CONFIDENCE = Number(process.env.MEDIAPIPE_POSE_MIN_PRESENCE_CONFIDENCE ?? "0.3");
const TRACKING_CONFIDENCE = Number(process.env.MEDIAPIPE_POSE_MIN_TRACKING_CONFIDENCE ?? "0.3");
const ROI_ENABLED = (process.env.MEDIAPIPE_POSE_ROI_ENABLED ?? "true").toLowerCase() !== "false";
const ROI_FALLBACK_MIN_POINTS = Number(process.env.MEDIAPIPE_POSE_ROI_MIN_POINTS ?? "8");
const ROI_PAD_MULT = Number(process.env.MEDIAPIPE_POSE_ROI_PAD_MULT ?? "1.1");
const ROI_MIN_WIDTH_MULT = Number(process.env.MEDIAPIPE_POSE_ROI_MIN_WIDTH_MULT ?? "3.0");
const ROI_MIN_HEIGHT_MULT = Number(process.env.MEDIAPIPE_POSE_ROI_MIN_HEIGHT_MULT ?? "3.6");
const UPSCALE_FACTOR = Number(process.env.MEDIAPIPE_POSE_UPSCALE ?? "1.5");

async function loadTasksVision() {
  try {
    // Avoid static import so webpack doesn't require the package at build time.
    const req = eval("require") as NodeRequire;
    return req("@mediapipe/tasks-vision");
  } catch (error) {
    throw new Error(
      `@mediapipe/tasks-vision not installed. Run npm i @mediapipe/tasks-vision or disable MediaPipe pose. ${String(error)}`
    );
  }
}

async function ensureModelFile(): Promise<string> {
  if (fs.existsSync(MODEL_CACHE_PATH)) return MODEL_CACHE_PATH;
  const res = await fetch(MODEL_URL);
  if (!res.ok) {
    throw new Error(`Failed to download mediapipe model: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(MODEL_CACHE_PATH, buffer);
  return MODEL_CACHE_PATH;
}

async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await loadTasksVision();
      const wasmPath = path.join(process.cwd(), "node_modules", "@mediapipe", "tasks-vision", "wasm");
      const fileset = await FilesetResolver.forVisionTasks(wasmPath);
      const modelPath = await ensureModelFile();
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: Number.isFinite(DETECTION_CONFIDENCE)
          ? Math.min(0.9, Math.max(0.05, DETECTION_CONFIDENCE))
          : 0.3,
        minPosePresenceConfidence: Number.isFinite(PRESENCE_CONFIDENCE)
          ? Math.min(0.9, Math.max(0.05, PRESENCE_CONFIDENCE))
          : 0.3,
        minTrackingConfidence: Number.isFinite(TRACKING_CONFIDENCE)
          ? Math.min(0.9, Math.max(0.05, TRACKING_CONFIDENCE))
          : 0.3,
      });
    })();
  }
  return landmarkerPromise;
}

async function getImageLandmarker() {
  if (!imageLandmarkerPromise) {
    imageLandmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await loadTasksVision();
      const wasmPath = path.join(process.cwd(), "node_modules", "@mediapipe", "tasks-vision", "wasm");
      const fileset = await FilesetResolver.forVisionTasks(wasmPath);
      const modelPath = await ensureModelFile();
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath },
        runningMode: "IMAGE",
        numPoses: 1,
        minPoseDetectionConfidence: Number.isFinite(DETECTION_CONFIDENCE)
          ? Math.min(0.9, Math.max(0.05, DETECTION_CONFIDENCE))
          : 0.3,
        minPosePresenceConfidence: Number.isFinite(PRESENCE_CONFIDENCE)
          ? Math.min(0.9, Math.max(0.05, PRESENCE_CONFIDENCE))
          : 0.3,
        minTrackingConfidence: Number.isFinite(TRACKING_CONFIDENCE)
          ? Math.min(0.9, Math.max(0.05, TRACKING_CONFIDENCE))
          : 0.3,
      });
    })();
  }
  return imageLandmarkerPromise;
}

async function getLowConfidenceImageLandmarker() {
  if (!lowConfidenceImageLandmarkerPromise) {
    lowConfidenceImageLandmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await loadTasksVision();
      const wasmPath = path.join(process.cwd(), "node_modules", "@mediapipe", "tasks-vision", "wasm");
      const fileset = await FilesetResolver.forVisionTasks(wasmPath);
      const modelPath = await ensureModelFile();
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath },
        runningMode: "IMAGE",
        numPoses: 1,
        minPoseDetectionConfidence: 0.1,
        minPosePresenceConfidence: 0.1,
        minTrackingConfidence: 0.1,
      });
    })();
  }
  return lowConfidenceImageLandmarkerPromise;
}

function normalizePoint(p?: { x: number; y: number } | null): PosePoint | null {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
}

async function decodeFrameToImageData(
  frame: { base64Image: string; mimeType: string },
  crop?: { x: number; y: number; width: number; height: number },
  scale = 1
) {
  const buffer = Buffer.from(frame.base64Image, "base64");
  let pipeline = sharp(buffer);
  if (crop) {
    pipeline = pipeline.extract({
      left: Math.max(0, Math.floor(crop.x)),
      top: Math.max(0, Math.floor(crop.y)),
      width: Math.max(1, Math.floor(crop.width)),
      height: Math.max(1, Math.floor(crop.height)),
    });
  }
  const normalizedScale = Number.isFinite(scale) ? Math.min(2.5, Math.max(1, scale)) : 1;
  if (normalizedScale > 1) {
    const metadata = await pipeline.metadata();
    const nextWidth = Math.max(1, Math.round((metadata.width ?? 0) * normalizedScale));
    const nextHeight = Math.max(1, Math.round((metadata.height ?? 0) * normalizedScale));
    if (nextWidth > 1 && nextHeight > 1) {
      pipeline = pipeline.resize(nextWidth, nextHeight, { fit: "fill" });
    }
  }
  const decoded = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = new Uint8ClampedArray(decoded.data);
  const width = decoded.info.width;
  const height = decoded.info.height;
  // MediaPipe Tasks only uses data/width/height, so a plain object works in Node.
  return { data, width, height } as ImageData;
}

function mapLandmarksToPose(landmarks: Array<{ x: number; y: number }>): Record<string, PosePoint | null> {
  const pose: Record<string, PosePoint | null> = {};
  Object.entries(LANDMARK_INDEX).forEach(([key, idx]) => {
    const lm = landmarks[idx];
    pose[key] = normalizePoint(lm ?? null);
  });
  return pose;
}

function poseQuality(pose?: Record<string, PosePoint | null>): number {
  if (!pose) return 0;
  const keys = Object.keys(LANDMARK_INDEX);
  let count = 0;
  for (const key of keys) {
    const p = pose[key];
    if (p) count += 1;
  }
  // Favor poses that include core anchors.
  const hasShoulders = !!(pose.leftShoulder && pose.rightShoulder);
  const hasWrist = !!(pose.leftWrist || pose.rightWrist);
  return count + (hasShoulders ? 3 : 0) + (hasWrist ? 2 : 0);
}

function mapLandmarksFromRoi(
  landmarks: Array<{ x: number; y: number }>,
  roi: RoiRect
): Array<{ x: number; y: number }> {
  return landmarks.map((lm) => ({
    x: Math.min(1, Math.max(0, (roi.x + lm.x * roi.width) / roi.fullWidth)),
    y: Math.min(1, Math.max(0, (roi.y + lm.y * roi.height) / roi.fullHeight)),
  }));
}

function computeRoiFromPose(pose: Record<string, PosePoint | null>, fullWidth: number, fullHeight: number): RoiRect | null {
  const points = Object.values(pose).filter((p): p is PosePoint => !!p);
  if (points.length < 3) return null;
  const xs = points.map((p) => p.x * fullWidth);
  const ys = points.map((p) => p.y * fullHeight);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  const ls = pose.leftShoulder;
  const rs = pose.rightShoulder;
  const shoulderWidth =
    ls && rs
      ? Math.hypot((ls.x - rs.x) * fullWidth, (ls.y - rs.y) * fullHeight)
      : Math.max(maxX - minX, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const padBase = Math.max(shoulderWidth * 0.8, Math.max(maxX - minX, maxY - minY) * 0.35);
  const pad = Number.isFinite(ROI_PAD_MULT) ? padBase * Math.max(1, ROI_PAD_MULT) : padBase;
  const minWidth = shoulderWidth * (Number.isFinite(ROI_MIN_WIDTH_MULT) ? Math.max(2.2, ROI_MIN_WIDTH_MULT) : 2.5);
  const minHeight = shoulderWidth * (Number.isFinite(ROI_MIN_HEIGHT_MULT) ? Math.max(2.6, ROI_MIN_HEIGHT_MULT) : 3.0);
  let roiWidth = Math.max(maxX - minX + pad * 2, minWidth, fullWidth * 0.3);
  let roiHeight = Math.max(maxY - minY + pad * 2, minHeight, fullHeight * 0.36);
  if (!Number.isFinite(roiWidth) || !Number.isFinite(roiHeight)) return null;
  roiWidth = Math.min(fullWidth, Math.max(1, roiWidth));
  roiHeight = Math.min(fullHeight, Math.max(1, roiHeight));
  minX = Math.max(0, Math.min(fullWidth - roiWidth, centerX - roiWidth / 2));
  minY = Math.max(0, Math.min(fullHeight - roiHeight, centerY - roiHeight / 2));
  return { x: minX, y: minY, width: roiWidth, height: roiHeight, fullWidth, fullHeight };
}

export async function extractPoseKeypointsFromImagesMediaPipe(params: {
  frames: Array<{ base64Image: string; mimeType: string; timestampSec?: number }>;
}): Promise<ExtractedPoseFrame[]> {
  if (!params.frames.length) return [];
  const landmarker = await getLandmarker();
  const out: ExtractedPoseFrame[] = [];
  let lastTimestampMs = 0;
  let lastPose: Record<string, PosePoint | null> | null = null;
  let lastRoi: RoiRect | null = null;
  let missStreak = 0;
  let imageLandmarker: unknown | null = null;
  let lowConfidenceLandmarker: unknown | null = null;
  for (let i = 0; i < params.frames.length; i += 1) {
    const frame = params.frames[i]!;
    const buffer = Buffer.from(frame.base64Image, "base64");
    const metadata = await sharp(buffer).metadata();
    const fullWidth = metadata.width ?? 0;
    const fullHeight = metadata.height ?? 0;
    const roiEnabledForFrame = ROI_ENABLED && fullWidth > 0 && fullHeight > 0 && missStreak < 2;
    const roi = roiEnabledForFrame ? lastRoi ?? (lastPose ? computeRoiFromPose(lastPose, fullWidth, fullHeight) : null) : null;
    const imageData = await decodeFrameToImageData(
      frame,
      roi ? { x: roi.x, y: roi.y, width: roi.width, height: roi.height } : undefined,
      UPSCALE_FACTOR
    );
    let result: { landmarks?: Array<Array<{ x: number; y: number }>> } | null = null;
    if (typeof (landmarker as { detectForVideo?: unknown }).detectForVideo === "function") {
      let tsMs = Number.isFinite(frame.timestampSec as number) ? Number(frame.timestampSec) * 1000 : i * 33.333;
      if (!Number.isFinite(tsMs)) tsMs = i * 33.333;
      if (tsMs <= lastTimestampMs) tsMs = lastTimestampMs + 1;
      lastTimestampMs = tsMs;
      result = (landmarker as {
        detectForVideo: (image: ImageData, timestampMs: number) => { landmarks?: Array<Array<{ x: number; y: number }>> };
      }).detectForVideo(imageData as ImageData, tsMs);
    } else {
      result = (landmarker as { detect: (image: ImageData) => { landmarks?: Array<Array<{ x: number; y: number }>> } }).detect(
        imageData as ImageData
      );
    }
    let landmarks = result?.landmarks?.[0] ?? [];
    if (roi && landmarks.length) {
      landmarks = mapLandmarksFromRoi(landmarks as Array<{ x: number; y: number }>, roi);
    }
    let pose = landmarks.length ? mapLandmarksToPose(landmarks as Array<{ x: number; y: number }>) : undefined;
    const roiQuality = poseQuality(pose);
    const roiPointCount = Object.keys(LANDMARK_INDEX).reduce((acc, key) => acc + (pose?.[key] ? 1 : 0), 0);
    const roiWeak = !!roi && (!pose || roiPointCount < ROI_FALLBACK_MIN_POINTS || roiQuality < ROI_FALLBACK_MIN_POINTS + 2);

    if (roiWeak || !landmarks.length) {
      const fallbackImage = await decodeFrameToImageData(frame, undefined, UPSCALE_FACTOR);
      let fallbackLandmarks: Array<{ x: number; y: number }> = [];
      if (typeof (landmarker as { detectForVideo?: unknown }).detectForVideo === "function") {
        const fallback = (landmarker as {
          detectForVideo: (image: ImageData, timestampMs: number) => { landmarks?: Array<Array<{ x: number; y: number }>> };
        }).detectForVideo(fallbackImage as ImageData, lastTimestampMs + 1);
        lastTimestampMs += 1;
        fallbackLandmarks = fallback?.landmarks?.[0] ?? [];
      } else if (typeof (landmarker as { detect?: unknown }).detect === "function") {
        const fallback = (landmarker as { detect: (image: ImageData) => { landmarks?: Array<Array<{ x: number; y: number }>> } })
          .detect(fallbackImage as ImageData);
        fallbackLandmarks = fallback?.landmarks?.[0] ?? [];
      }
      const fallbackPose = fallbackLandmarks.length ? mapLandmarksToPose(fallbackLandmarks as Array<{ x: number; y: number }>) : undefined;
      const fallbackQuality = poseQuality(fallbackPose);
      if (fallbackQuality > roiQuality) {
        pose = fallbackPose;
      }
      if ((!fallbackLandmarks.length || fallbackQuality <= roiQuality) && imageLandmarker == null) {
        imageLandmarker = await getImageLandmarker();
      }
      if (imageLandmarker && (!fallbackLandmarks.length || fallbackQuality <= roiQuality)) {
        const imageResult = (imageLandmarker as {
          detect: (image: ImageData) => { landmarks?: Array<Array<{ x: number; y: number }>> };
        }).detect(fallbackImage as ImageData);
        const imageLandmarks = imageResult?.landmarks?.[0] ?? [];
        const imagePose = imageLandmarks.length ? mapLandmarksToPose(imageLandmarks as Array<{ x: number; y: number }>) : undefined;
        if (poseQuality(imagePose) > poseQuality(pose)) {
          pose = imagePose;
        }
      }
      if (!pose || poseQuality(pose) <= 0) {
        if (lowConfidenceLandmarker == null) {
          lowConfidenceLandmarker = await getLowConfidenceImageLandmarker();
        }
        const lowResult = (lowConfidenceLandmarker as {
          detect: (image: ImageData) => { landmarks?: Array<Array<{ x: number; y: number }>> };
        }).detect(fallbackImage as ImageData);
        const lowLandmarks = lowResult?.landmarks?.[0] ?? [];
        const lowPose = lowLandmarks.length ? mapLandmarksToPose(lowLandmarks as Array<{ x: number; y: number }>) : undefined;
        if (poseQuality(lowPose) > poseQuality(pose)) {
          pose = lowPose;
        }
      }
    }
    if (pose && fullWidth > 0 && fullHeight > 0) {
      lastPose = pose;
      lastRoi = computeRoiFromPose(pose, fullWidth, fullHeight);
      missStreak = 0;
    } else {
      missStreak += 1;
      if (missStreak >= 2) {
        lastRoi = null;
      }
    }
    out.push({ idx: i, pose, club: { shaftVector: null } });
  }
  return out;
}
