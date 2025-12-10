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
}

// New OpenAI Vision Chat Completions message content type for requests
type OpenAIRequestMessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIResponseMessageContent = string | object;

export async function askVisionAPI({ frames, prompt }: AskVisionAPIParams): Promise<unknown> {
  const apiKey = assertEnv(OPENAI_API_KEY, "OPENAI_API_KEY");
  const model = OPENAI_MODEL === "gpt-4o" || OPENAI_MODEL === "gpt-4o-mini" ? OPENAI_MODEL : "gpt-4o";
  const limitedFrames = frames.slice(0, 6);
  const enhancedPrompt = `${prompt}

※以下の画像フレームの内容を主に参照して分析を行ってください。
テンプレート的な文章ではなく、フレームごとの動きに即した具体的な日本語分析を返してください。
必ず JSON オブジェクトのみを出力し、前後のコメントは禁止します。
`;

  // 🔥 OpenAI Vision 正しい content 構造
  const content: OpenAIRequestMessageContent[] = [];

  content.push({
    type: "text",
    text: enhancedPrompt,
  });

  // フレームを最大5枚まで画像として追加（順序を保持）
  for (const frame of limitedFrames) {
    if (!frame?.base64Image || !frame?.mimeType) continue;
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${frame.mimeType};base64,${frame.base64Image}`,
      },
    });
  }

  // Vision が画像後に制御文を読んだほうが従うため、補強のために1行追加
  content.push({
    type: "text",
    text: "※出力は JSON のみ（日本語）、テンプレではなくフレーム観察に基づく内容にしてください。",
  });

  const payload = {
    model,
    // system を先頭に追加し Vision の挙動を固定化
    messages: [
      {
        role: "system" as const,
        content: SYSTEM_ROLE,
      },
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
  const rawContent = data?.choices?.[0]?.message?.content ?? null;

  // Vision の content が object / string 両可能性に対応
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
