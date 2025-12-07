// app/lib/openai.ts

const OPENAI_API_BASE = process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function assertOpenAIKey(): string {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return OPENAI_API_KEY;
}

function extractOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const payloadRecord = payload as Record<string, unknown>;

  if (typeof payloadRecord.output_text === "string") {
    return payloadRecord.output_text;
  }

  const outputArray = Array.isArray(payloadRecord.output)
    ? (payloadRecord.output as unknown[])
    : [];
  const outputText = outputArray.find((item): item is { text?: unknown; type?: unknown; object?: unknown } => {
    if (!item || typeof item !== "object") return false;
    const entry = item as { text?: unknown; type?: unknown; object?: unknown };
    return (
      entry.type === "output_text" ||
      entry.object === "output_text" ||
      typeof entry.text === "string"
    );
  });

  if (outputText && typeof outputText.text === "string") {
    return outputText.text;
  }

  const choices = payloadRecord.choices;
  if (
    Array.isArray(choices) &&
    choices[0] &&
    typeof choices[0] === "object" &&
    typeof (choices[0] as { message?: { content?: unknown } }).message?.content === "string"
  ) {
    return (choices[0] as { message?: { content?: unknown } }).message?.content as string;
  }

  return null;
}

export async function createVisionJsonResponse(params: {
  prompt: string;
  base64Image: string;
  mimeType: string;
}) {
  const apiKey = assertOpenAIKey();

  const response = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: params.prompt },
            {
              type: "input_image",
              image_url: `data:${params.mimeType};base64,${params.base64Image}`,
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenAI API request failed: ${response.status} ${response.statusText} ${errorText}`
    );
  }

  const payload = await response.json();
  const outputText = extractOutputText(payload);

  if (!outputText) {
    throw new Error("OpenAI response did not include JSON text output");
  }

  return {
    payload,
    outputText,
  };
}

export function getOpenAIEnv() {
  return {
    apiKey: assertOpenAIKey(),
    baseUrl: OPENAI_API_BASE,
    model: OPENAI_MODEL,
  };
}
