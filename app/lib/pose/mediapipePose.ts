import "server-only";

import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";

import type { ExtractedPoseFrame } from "@/app/lib/vision/extractPoseKeypoints";

type PosePoint = { x: number; y: number };

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

const DETECTION_CONFIDENCE = Number(process.env.MEDIAPIPE_POSE_MIN_DETECTION_CONFIDENCE ?? "0.3");
const PRESENCE_CONFIDENCE = Number(process.env.MEDIAPIPE_POSE_MIN_PRESENCE_CONFIDENCE ?? "0.3");
const TRACKING_CONFIDENCE = Number(process.env.MEDIAPIPE_POSE_MIN_TRACKING_CONFIDENCE ?? "0.3");

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

function normalizePoint(p?: { x: number; y: number } | null): PosePoint | null {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
}

async function decodeFrameToImageData(frame: { base64Image: string; mimeType: string }) {
  const buffer = Buffer.from(frame.base64Image, "base64");
  const decoded = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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

export async function extractPoseKeypointsFromImagesMediaPipe(params: {
  frames: Array<{ base64Image: string; mimeType: string; timestampSec?: number }>;
}): Promise<ExtractedPoseFrame[]> {
  if (!params.frames.length) return [];
  const landmarker = await getLandmarker();
  const out: ExtractedPoseFrame[] = [];
  let lastTimestampMs = 0;
  for (let i = 0; i < params.frames.length; i += 1) {
    const frame = params.frames[i]!;
    const imageData = await decodeFrameToImageData(frame);
    let result: { landmarks?: Array<Array<{ x: number; y: number }>> } | null = null;
    if (typeof (landmarker as { detectForVideo?: unknown }).detectForVideo === "function") {
      let tsMs = Number.isFinite(frame.timestampSec as number) ? Number(frame.timestampSec) * 1000 : i * 33.333;
      if (!Number.isFinite(tsMs)) tsMs = i * 33.333;
      if (tsMs <= lastTimestampMs) tsMs = lastTimestampMs + 1;
      lastTimestampMs = tsMs;
      result = (landmarker as { detectForVideo: (image: ImageData, timestampMs: number) => { landmarks?: Array<Array<{ x: number; y: number }>> } })
        .detectForVideo(imageData as ImageData, tsMs);
    } else {
      result = (landmarker as { detect: (image: ImageData) => { landmarks?: Array<Array<{ x: number; y: number }>> } })
        .detect(imageData as ImageData);
    }
    let landmarks = result?.landmarks?.[0] ?? [];
    if (!landmarks.length && typeof (landmarker as { detect?: unknown }).detect === "function") {
      const fallback = (landmarker as { detect: (image: ImageData) => { landmarks?: Array<Array<{ x: number; y: number }>> } })
        .detect(imageData as ImageData);
      landmarks = fallback?.landmarks?.[0] ?? [];
    }
    const pose = landmarks.length ? mapLandmarksToPose(landmarks as Array<{ x: number; y: number }>) : undefined;
    out.push({ idx: i, pose, club: { shaftVector: null } });
  }
  return out;
}
