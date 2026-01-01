import "server-only";

import OpenAI from "openai";

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
    const content: OpenAIRequestMessageContent[] = [
      {
        type: "text",
        text: `Return JSON only. Always include {"frames":[...]} with frames.length === ${batch.length}. If unsure about a keypoint, use null. Each frame is independent; do not copy-paste coordinates across frames.`,
      },
    ];
    batch.forEach((f, idx) => {
      content.push({ type: "text", text: `frame #${idx}` });
      content.push({
        type: "image_url",
        image_url: { url: `data:${f.mimeType};base64,${f.base64Image}`, detail: "high" },
      });
    });

    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
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

      // If the model returned fewer frames than requested, retry once.
      if (out.length >= Math.max(1, Math.floor(batch.length * 0.75))) {
        return out;
      }
      lastError = `pose batch returned ${out.length}/${batch.length} frames`;
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
