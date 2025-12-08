"use server";

import { askVisionAPI } from "../lib/vision/askVisionAPI";
import { PhaseFrame } from "../lib/vision/extractPhaseFrames";

const OPENAI_API_BASE = process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VIDEO_EMBED_MODEL = "gpt-4o-vision-video-embed";

export const SWING_ANALYSIS_PROMPT = `
You are a professional golf swing analyzer.

与えられた代表フレームをもとに、日本語で詳細なスイング分析を行い、
以下の構造を持つ JSON オブジェクト「result」を返してください。

{
  "summary": "スイング全体の総評（300〜500文字程度で詳しく）",
  "issues": ["具体的な問題点を箇条書きで"],
  "cues": ["改善のための短いコーチングキューを箇条書きで"],
  "priority": "改善すべき項目の優先順位を文章で記述",
}

必ず JSON のみ出力し、前後の文章は挿入しないこと。
`;

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

  const nodeBlob = new Blob([buffer], { type: mimeType });
  form.append("file", nodeBlob, safeName);
  form.append("model", VIDEO_EMBED_MODEL);

  const response = await fetch(`${OPENAI_API_BASE}/embeddings`, {
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

  const sortedLimited = [...frames]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 5);

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

  const phaseFrames = await createPhaseFramesFromVideo(videoFile, buffer);

  const vision = await askVisionAPI({
    frames: phaseFrames,
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

  return { frames: phaseFrames, vision: parsed };
}

