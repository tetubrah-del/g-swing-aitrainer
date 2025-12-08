import { PhaseFrame } from "./extractPhaseFrames";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_BASE = process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

function assertEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export interface AskVisionAPIParams {
  frames: PhaseFrame[];
  prompt: string;
}

// New OpenAI Vision Chat Completions message content type for requests
type OpenAIRequestMessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIResponseMessageContent = string | object;

export async function askVisionAPI({ frames, prompt }: AskVisionAPIParams): Promise<unknown> {
  const apiKey = assertEnv(OPENAI_API_KEY, "OPENAI_API_KEY");
  const model = OPENAI_MODEL === "gpt-4o" || OPENAI_MODEL === "gpt-4o-mini" ? OPENAI_MODEL : "gpt-4o";

  // 🔥 OpenAI Vision 正しい content 構造
  const content: OpenAIRequestMessageContent[] = [];

  content.push({
    type: "text",
    text: prompt,
  });

  // フレームをすべて画像として追加
  for (const frame of frames) {
    if (!frame?.base64Image || !frame?.mimeType) continue;
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${frame.mimeType};base64,${frame.base64Image}`,
      },
    });
  }

  const payload = {
    model,
    messages: [
      {
        role: "user" as const,
        content,
      },
    ],
    response_format: {
      type: "json_object",
    },
  };

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
    choices?: Array<{ message?: { content?: OpenAIResponseMessageContent } }>;
    error?: unknown;
  };
  const output = data.choices?.[0]?.message?.content;

  // If content is already a parsed JSON object
  if (output && typeof output === "object") {
    return output;
  }

  // If model returned JSON as a string
  if (typeof output === "string") {
    try {
      return JSON.parse(output);
    } catch {
      throw new Error("Response content was string but not valid JSON");
    }
  }

  throw new Error("OpenAI response did not include valid JSON");
}
