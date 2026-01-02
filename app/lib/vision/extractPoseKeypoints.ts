import "server-only";

import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";

import { extractPoseKeypointsFromImagesMediaPipe } from "@/app/lib/pose/mediapipePose";

type PosePoint = { x: number; y: number };
type Pose = Partial<{
  leftShoulder: PosePoint;
  rightShoulder: PosePoint;
  leftElbow: PosePoint;
  rightElbow: PosePoint;
  leftWrist: PosePoint;
  rightWrist: PosePoint;
  leftHip: PosePoint;
  rightHip: PosePoint;
  leftKnee: PosePoint;
  rightKnee: PosePoint;
  leftAnkle: PosePoint;
  rightAnkle: PosePoint;
}>;

export type ExtractedPoseFrame = {
  idx: number;
  pose?: Pose;
  club?: { shaftVector: [number, number] | null };
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_API_BASE ?? undefined,
  // Server-only file, but MediaPipe stubs define document; avoid browser guard trips.
  dangerouslyAllowBrowser: true,
});

const resolvePoseModel = () => {
  const raw = process.env.OPENAI_POSE_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o";
  const model = String(raw || "").trim();
  return model || "gpt-4o";
};

const SYSTEM_PROMPT = `
You are a vision model. Extract human pose keypoints and an approximate club shaft direction for each image.

For EACH input image, return an object with:
- idx: the image index (0-based, same order as provided)
- pose: { leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle }
  - each keypoint is { x, y } in normalized [0,1] (origin = top-left of image)
  - do NOT reuse the same coordinates across frames; estimate each frame independently
  - if a keypoint can't be determined, set it to null (do not invent)
- club: { shaftVector: [dx, dy] | null }
  - dx,dy is a unit-ish 2D vector pointing from grip to clubhead; if unknown, set shaftVector: null

Output JSON only in this shape:
{ "frames": [ { "idx": 0, "pose": { ... }, "club": { "shaftVector": [dx, dy] | null } }, ... ] }

IMPORTANT:
- Always return frames.length === number of input images.
- Always include idx for every frame (0..N-1).
- Keep all x,y values within [0,1].

Do not add explanations.`;

const POSE_DEBUG_SAVE = (process.env.POSE_DEBUG_SAVE ?? "false").toLowerCase() === "true";
const POSE_DEBUG_SAVE_IMAGES = (process.env.POSE_DEBUG_SAVE_IMAGES ?? "false").toLowerCase() === "true";
const POSE_DEBUG_DIR = process.env.POSE_DEBUG_DIR ?? path.join(os.tmpdir(), "pose-llm-debug");
const POSE_DEBUG_IMAGES_DIR = process.env.POSE_DEBUG_IMAGES_DIR ?? path.join(os.tmpdir(), "pose-llm-debug-images");
const POSE_LLM_ROI_ENABLED = (process.env.POSE_LLM_ROI_ENABLED ?? "false").toLowerCase() === "true";
const POSE_LLM_ROI_X = Number(process.env.POSE_LLM_ROI_X ?? "0.1");
const POSE_LLM_ROI_Y = Number(process.env.POSE_LLM_ROI_Y ?? "0.05");
const POSE_LLM_ROI_W = Number(process.env.POSE_LLM_ROI_W ?? "0.8");
const POSE_LLM_ROI_H = Number(process.env.POSE_LLM_ROI_H ?? "0.9");
const POSE_LLM_ROI_LONG_EDGE = Number(process.env.POSE_LLM_ROI_LONG_EDGE ?? "0");

function parseJsonContent(content: unknown) {
  if (content === null || content === undefined) return {};
  if (typeof content === "object") return content;
  const text = String(content).trim();
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const clamp01 = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
};

async function cropFrameForLLM(frame: { base64Image: string; mimeType: string }) {
  if (!POSE_LLM_ROI_ENABLED) return frame;
  const buffer = Buffer.from(frame.base64Image, "base64");
  let pipeline = sharp(buffer);
  const metadata = await pipeline.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 1 || height <= 1) return frame;
  const roiX = clamp01(POSE_LLM_ROI_X, 0.1);
  const roiY = clamp01(POSE_LLM_ROI_Y, 0.05);
  const roiW = clamp01(POSE_LLM_ROI_W, 0.8);
  const roiH = clamp01(POSE_LLM_ROI_H, 0.9);
  const left = Math.max(0, Math.min(width - 1, Math.round(width * roiX)));
  const top = Math.max(0, Math.min(height - 1, Math.round(height * roiY)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(width * roiW)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(height * roiH)));
  pipeline = pipeline.extract({ left, top, width: cropWidth, height: cropHeight });
  const targetLongEdge = Number.isFinite(POSE_LLM_ROI_LONG_EDGE) ? Math.max(0, Math.round(POSE_LLM_ROI_LONG_EDGE)) : 0;
  if (targetLongEdge > 0) {
    const longEdge = Math.max(cropWidth, cropHeight);
    if (longEdge > 0 && longEdge !== targetLongEdge) {
      const scale = targetLongEdge / longEdge;
      const nextWidth = Math.max(1, Math.round(cropWidth * scale));
      const nextHeight = Math.max(1, Math.round(cropHeight * scale));
      pipeline = pipeline.resize(nextWidth, nextHeight, { fit: "fill" });
    }
  }
  const out = await pipeline.jpeg({ quality: 90 }).toBuffer();
  return { base64Image: out.toString("base64"), mimeType: "image/jpeg" };
}

export async function extractPoseKeypointsFromImages(params: {
  frames: Array<{ base64Image: string; mimeType: string; timestampSec?: number }>;
}): Promise<ExtractedPoseFrame[]> {
  const useMediaPipe =
    process.env.POSE_PROVIDER === "mediapipe" ||
    process.env.USE_MEDIAPIPE_POSE === "1";
  if (useMediaPipe) {
    try {
      return await extractPoseKeypointsFromImagesMediaPipe(params);
    } catch (error) {
      console.warn("[pose] mediapipe failed, fallback to vision", error);
    }
  }
  if (!client.apiKey) {
    throw new Error("OPENAI_API_KEY is not set (pose extraction)");
  }
  if (!params.frames.length) return [];

  type OpenAIRequestMessageContent =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" } };

  const extractBatch = async (batch: Array<{ base64Image: string; mimeType: string }>, batchOffset: number) => {
    const processedBatch = POSE_LLM_ROI_ENABLED
      ? await Promise.all(batch.map((frame) => cropFrameForLLM(frame)))
      : batch;
    const content: OpenAIRequestMessageContent[] = [
      {
        type: "text",
        text: `Return JSON only. Always include {"frames":[...]} with frames.length === ${batch.length}. If unsure about a keypoint, use null. Each frame is independent; do not copy-paste coordinates across frames.`,
      },
    ];
    processedBatch.forEach((f, idx) => {
      if (POSE_DEBUG_SAVE_IMAGES) {
        const mime = String(f.mimeType || "image/jpeg");
        const ext = mime.includes("/") ? `.${mime.split("/")[1]}` : ".jpg";
        const fileName = `pose-input-${Date.now()}-${batchOffset + idx}${ext}`;
        const outPath = path.join(POSE_DEBUG_IMAGES_DIR, fileName);
        void fs
          .mkdir(POSE_DEBUG_IMAGES_DIR, { recursive: true })
          .then(() => fs.writeFile(outPath, Buffer.from(f.base64Image, "base64")))
          .catch(() => null);
      }
      content.push({ type: "text", text: `frame #${idx}` });
      content.push({
        type: "image_url",
        image_url: { url: `data:${f.mimeType};base64,${f.base64Image}`, detail: "high" },
      });
    });

    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retryHint =
        attempt === 0
          ? []
          : [
              {
                type: "text" as const,
                text: "RETRY: The previous response returned too many null keypoints. If a golfer is visible, estimate the main body joints. Only use null when a body part is fully occluded.",
              },
            ];
      const result = await client.chat.completions.create({
        model: resolvePoseModel(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              attempt === 0
                ? content
                : [
                    ...content,
                    ...retryHint,
                    {
                      type: "text",
                      text: `REMINDER: frames must have exactly ${batch.length} items with idx 0..${batch.length - 1} (no omissions).`,
                    },
                  ],
          },
        ],
        // Smaller batches prevent JSON truncation; keep output roomy anyway.
        max_tokens: 4096,
        temperature: 0.0,
        response_format: { type: "json_object" },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const structured = (result as any).choices?.[0]?.message?.parsed ?? result.choices?.[0]?.message?.content;
      const json = parseJsonContent(structured) as { frames?: unknown };
      const frames = Array.isArray(json.frames) ? (json.frames as unknown[]) : [];
      if (POSE_DEBUG_SAVE) {
        const fileName = `pose-llm-raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
        const outPath = path.join(POSE_DEBUG_DIR, fileName);
        const payload = {
          createdAt: new Date().toISOString(),
          batchSize: batch.length,
          batchOffset,
          model: resolvePoseModel(),
          raw: structured,
          parsed: json,
        };
        await fs.mkdir(POSE_DEBUG_DIR, { recursive: true });
        await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
      }

      const out: ExtractedPoseFrame[] = [];
      for (let i = 0; i < frames.length; i += 1) {
        const entry = frames[i];
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const idxRaw = e.idx;
        const idx = Number(idxRaw);
        const finalIdx = Number.isFinite(idx) ? idx : i;
        out.push({
          idx: finalIdx + batchOffset,
          pose: (e.pose as Pose | undefined) ?? undefined,
          club: (e.club as { shaftVector: [number, number] | null } | undefined) ?? undefined,
        });
      }

      const hasAnyPose = out.some((frame) => {
        const pose = frame.pose as Record<string, { x?: number; y?: number } | null> | undefined;
        if (!pose) return false;
        return Object.values(pose).some((p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y));
      });
      // If the model returned fewer frames than requested or all-null poses, retry once.
      if (out.length >= Math.max(1, Math.floor(batch.length * 0.75)) && hasAnyPose) {
        return out;
      }
      lastError = hasAnyPose
        ? `pose batch returned ${out.length}/${batch.length} frames`
        : `pose batch returned ${out.length}/${batch.length} frames (all null poses)`;
    }

    throw new Error(lastError ?? "pose extraction failed");
  };

  const BATCH_SIZE = 4;
  const combined: ExtractedPoseFrame[] = [];
  for (let start = 0; start < params.frames.length; start += BATCH_SIZE) {
    const batch = params.frames.slice(start, start + BATCH_SIZE);
    const batchOut = await extractBatch(batch, start);
    combined.push(...batchOut);
  }

  return combined.sort((a, b) => a.idx - b.idx);
}
