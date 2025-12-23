import "server-only";

import OpenAI from "openai";

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
});

const PROMPT = `
You are a vision model. Extract human pose keypoints and club shaft vector for each image.

For EACH input image, return an object with:
- idx: the image index (0-based, same order as provided)
- pose: { leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle } with x,y in normalized [0,1] coordinates (origin = top-left of image)
- club: { shaftVector: [dx, dy] } where dx,dy is a unit-ish 2D vector pointing from grip to clubhead; if unknown, set shaftVector: null

Output JSON only in this shape:
{ "frames": [ { "idx": 0, "pose": { ... }, "club": { "shaftVector": [dx, dy] | null } }, ... ] }

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
  frames: Array<{ base64Image: string; mimeType: string }>;
}): Promise<ExtractedPoseFrame[]> {
  if (!client.apiKey) return [];
  if (!params.frames.length) return [];

  type OpenAIRequestMessageContent =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" } };

  const content: OpenAIRequestMessageContent[] = [{ type: "text", text: PROMPT }];
  params.frames.forEach((f, idx) => {
    content.push({ type: "text", text: `frame #${idx}` });
    content.push({
      type: "image_url",
      image_url: { url: `data:${f.mimeType};base64,${f.base64Image}`, detail: "low" },
    });
  });

  const result = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content }],
    max_tokens: 600,
    temperature: 0.0,
    response_format: { type: "json_object" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const structured = (result as any).choices?.[0]?.message?.parsed ?? result.choices?.[0]?.message?.content;
  const json = parseJsonContent(structured) as { frames?: unknown };
  const frames = Array.isArray(json.frames) ? (json.frames as unknown[]) : [];

  const out: ExtractedPoseFrame[] = [];
  for (const entry of frames) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const idx = Number(e.idx);
    if (!Number.isFinite(idx)) continue;
    out.push({
      idx,
      pose: (e.pose as Pose | undefined) ?? undefined,
      club: (e.club as { shaftVector: [number, number] | null } | undefined) ?? undefined,
    });
  }

  return out.sort((a, b) => a.idx - b.idx);
}

