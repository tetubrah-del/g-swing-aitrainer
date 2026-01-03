import { PhaseFrame } from "./extractPhaseFrames";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE = process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

// 画像依存分析を強制する強力な system プロンプト
const SYSTEM_ROLE = `
あなたはゴルフスイングの分析専門 AI です。
提供されたフレーム画像のみを根拠に分析してください。
一般論・テンプレは禁止です。
必ず JSON のみを返してください。
`;

function assertEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export interface AskVisionAPIParams {
  frames: PhaseFrame[];
  prompt: string;
  usageTag?: string;
}

// New OpenAI Vision Chat Completions message content type for requests
type OpenAIRequestMessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIResponseMessageContent = string | object;

function buildPayload(frames: PhaseFrame[], prompt: string, limit: number, model: string) {
  const enhancedPrompt = `${prompt}

※以下の画像フレームの内容を主に参照して分析を行ってください。
テンプレート的な文章ではなく、フレームごとの動きに即した具体的な日本語分析を返してください。
必ず JSON オブジェクトのみを出力し、前後のコメントは禁止します。
`;

  const content: OpenAIRequestMessageContent[] = [];
  content.push({ type: "text", text: enhancedPrompt });

  for (const frame of frames.slice(0, limit)) {
    if (!frame?.base64Image || !frame?.mimeType) continue;
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${frame.mimeType};base64,${frame.base64Image}`,
      },
    });
  }

  content.push({
    type: "text",
    text: "※出力は JSON のみ（日本語）、テンプレではなくフレーム観察に基づく内容にしてください。",
  });

  return {
    model,
    // Make outputs as stable as possible for "same input => same result".
    temperature: 0,
    top_p: 1,
    messages: [
      { role: "system" as const, content: SYSTEM_ROLE },
      { role: "user" as const, content },
    ],
    response_format: { type: "json_object" },
  };
}

async function callOpenAI(payload: unknown, options: { usageTag?: string; frameCount: number; model: string }) {
  const apiKey = assertEnv(OPENAI_API_KEY, "OPENAI_API_KEY");
  const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`OpenAI API request failed: ${response.status} ${response.statusText} ${errorBody}`);
  }

  const data = (await response.json()) as {
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
    choices?: Array<{ message?: { content?: OpenAIResponseMessageContent } }>;
    error?: { message?: string };
  };

  if (data?.error) {
    throw new Error(`OpenAI error: ${data.error.message || "unknown error"}`);
  }

  if (options.usageTag && (process.env.ON_PLANE_USAGE_LOG ?? "").toLowerCase() === "true") {
    console.log("[onplane-usage]", {
      tag: options.usageTag,
      model: data?.model ?? options.model,
      frames: options.frameCount,
      usage: data?.usage ?? null,
    });
  }

  return data?.choices?.[0]?.message?.content ?? null;
}

export async function askVisionAPI({ frames, prompt, usageTag }: AskVisionAPIParams): Promise<unknown> {
  const model = OPENAI_MODEL === "gpt-4o" || OPENAI_MODEL === "gpt-4o-mini" ? OPENAI_MODEL : "gpt-4o";
  const MAX_FRAMES = 16;
  const limitedFrames = frames.slice(0, MAX_FRAMES);

  const attempt = async (limit: number) => {
    const payload = buildPayload(limitedFrames, prompt, limit, model);
    return callOpenAI(payload, { usageTag, frameCount: limit, model });
  };

  let rawContent = await attempt(limitedFrames.length).catch(() => null);
  if (rawContent == null) {
    const fallbackLimit = Math.min(6, limitedFrames.length);
    rawContent = await attempt(Math.max(1, fallbackLimit)).catch(() => null);
  }

  if (rawContent == null) {
    throw new Error("Vision API returned empty response");
  }

  if (typeof rawContent === "object" && rawContent !== null) {
    return rawContent;
  }

  if (typeof rawContent === "string") {
    try {
      return JSON.parse(rawContent);
    } catch {
      console.error("askVisionAPI JSON parse fail:", rawContent);
      return rawContent;
    }
  }

  return rawContent;
}
