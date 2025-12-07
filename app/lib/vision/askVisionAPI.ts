import { visionResponseSchema } from "./parseVisionResponse";

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
  prompt: string;
  base64Image: string;
  mimeType: string;
}

export async function askVisionAPI({ prompt, base64Image, mimeType }: AskVisionAPIParams): Promise<string> {
  const apiKey = assertEnv(OPENAI_API_KEY, "OPENAI_API_KEY");
  const model = OPENAI_MODEL === "gpt-4o" || OPENAI_MODEL === "gpt-4o-mini" ? OPENAI_MODEL : "gpt-4o";

  const payload = {
    model,
    messages: [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: prompt },
          {
            type: "image_url" as const,
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "golf_swing_analysis",
        strict: true,
        schema: {
          type: "object",
          properties: visionResponseSchema.properties,
          required: Object.keys(visionResponseSchema.properties ?? {}),
          additionalProperties: false,
        },
      },
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

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown };
  const output = data.choices?.[0]?.message?.content;

  if (!output || typeof output !== "string") {
    throw new Error("OpenAI response did not include JSON text output");
  }

  return output.trim();
}
