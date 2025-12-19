"use server";

// 🔥 Server Actions：結果を JSON で返す。redirect は使わない。

import {
  attachPoseKeypoints, defaultDetectKeypoints, determineSwingPhases
} from "../lib/pose/determineSwingPhases";
import { SWING_ANALYSIS_PROMPT } from "../lib/prompts/swingAnalysisPrompt";
import { askVisionAPI } from "../lib/vision/askVisionAPI";
import { PhaseFrame } from "../lib/vision/extractPhaseFrames";

const OPENAI_API_BASE = process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VIDEO_EMBED_MODEL = "gpt-4o-vision-video-embed";

type VideoEmbeddingFrame = {
  image: string;
  mime_type: string;
  timestamp: number;
};

type VideoEmbeddingResponse = {
  data?: Array<{ frames?: VideoEmbeddingFrame[] }>;
  error?: unknown;
};

export interface AnalyzeVideoResult {
  frames: PhaseFrame[];
  rawFrames: PhaseFrame[];
  vision: unknown;
}

function assertOpenAIKey(value: string | undefined): string {
  if (!value) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return value;
}

async function createPhaseFramesFromVideo(file: File, buffer: Buffer): Promise<PhaseFrame[]> {
  const apiKey = assertOpenAIKey(OPENAI_API_KEY);

  const form = new FormData();
  const safeName = (file.name || "video.mp4").replace(/[^\w.\-]/g, "_");
  const mimeType = file.type && file.type.includes("/") ? file.type : "video/mp4";

  const arrayBufferForBlob = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const nodeBlob = new Blob([arrayBufferForBlob], { type: mimeType });
  form.append("file", nodeBlob, safeName);
  form.append("model", VIDEO_EMBED_MODEL);

  const response = await fetch(`${OPENAI_API_BASE}/embeddings-video`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Video embedding request failed: ${response.status} ${response.statusText} ${body}`);
  }

  const payload = (await response.json()) as VideoEmbeddingResponse;
  const frames = payload.data?.[0]?.frames ?? [];

  if (!frames.length) throw new Error("Embedding response did not include frames");

  const sortedLimited = [...frames].sort((a, b) => a.timestamp - b.timestamp).slice(0, 120);

  return sortedLimited.map((f) => ({
    id: `ts-${f.timestamp.toFixed(2)}`,
    base64Image: f.image,
    mimeType: f.mime_type,
    timestampSec: f.timestamp,
  }));
}

export async function analyzeVideo(formData: FormData): Promise<AnalyzeVideoResult> {
  const videoFile = formData.get("video");

  if (!(videoFile instanceof File)) {
    throw new Error("動画ファイルを指定してください");
  }

  const arrayBuffer = await videoFile.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // raw frames (120フレーム)
  const rawFrames = await createPhaseFramesFromVideo(videoFile, buffer);

  // ★ フェーズ抽出用 fake pose を付与
  const poseFrames = await attachPoseKeypoints(rawFrames, defaultDetectKeypoints);

  // ★ 6つのフェーズ抽出（address / backswing / top / downswing / impact / finish）
  const sixPhaseFrames = determineSwingPhases(poseFrames);

  const vision = await askVisionAPI({
    frames: sixPhaseFrames, // Vision は代表6フェーズのみを解析
    prompt: SWING_ANALYSIS_PROMPT,
  });

  let parsed = vision;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      console.error("Vision JSON parse failed:", parsed);
    }
  }

  const result = { frames: sixPhaseFrames, rawFrames, vision: parsed };

  // Next.js がクライアントへ自動で伝搬する
  return result;
}
