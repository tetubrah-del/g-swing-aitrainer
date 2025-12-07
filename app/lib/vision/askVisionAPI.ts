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

type OpenAIMessageContent =
  | string
  | Array<
      | { type: "text"; text?: string }
      | { type: "output_text"; text?: string }
      | { type: "output_json"; json?: unknown }
    >;

export async function askVisionAPI({ frames, prompt }: AskVisionAPIParams): Promise<unknown> {
  const apiKey = assertEnv(OPENAI_API_KEY, "OPENAI_API_KEY");
  const model = OPENAI_MODEL === "gpt-4o" || OPENAI_MODEL === "gpt-4o-mini" ? OPENAI_MODEL : "gpt-4o";

  const content = [
    { type: "input_text" as const, text: prompt },
    ...frames.map((frame) => ({
      type: "input_image" as const,
      image_url: { url: `data:${frame.mimeType};base64,${frame.base64Image}` },
    })),
  ];

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
    choices?: Array<{ message?: { content?: OpenAIMessageContent } }>;
    error?: unknown;
  };
  const output = data.choices?.[0]?.message?.content;

  if (Array.isArray(output)) {
    const jsonPart = output.find((part) => part && typeof part === "object" && "type" in part && part.type === "output_json");
    if (jsonPart && typeof jsonPart === "object" && "json" in jsonPart) {
      return (jsonPart as { json?: unknown }).json;
    }
  }

  if (typeof output === "string") {
    return JSON.parse(output);
  }

  throw new Error("OpenAI response did not include JSON text output");
}
