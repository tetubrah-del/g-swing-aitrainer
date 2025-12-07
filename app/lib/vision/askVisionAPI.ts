import { GolfAnalyzeMeta } from "@/app/golf/types";
import { SwingFrame } from "./extractFrames";

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
  frames: SwingFrame[];
  meta?: GolfAnalyzeMeta;
}

export async function askVisionAPI({ frames, meta }: AskVisionAPIParams): Promise<string> {
  const apiKey = assertEnv(OPENAI_API_KEY, "OPENAI_API_KEY");
  const model = OPENAI_MODEL === "gpt-4o" || OPENAI_MODEL === "gpt-4o-mini" ? OPENAI_MODEL : "gpt-4o";

  const prompt = [
    "You are a professional Japanese golf swing coach.",
    "The following images are ordered keyframes from a single swing (takeaway → top → impact → follow-through).",
    "Analyze all frames holistically and return ONLY one JSON object with this exact schema:",
    '{"impact_face_angle": number, "club_path": number, "body_open_angle": number, "hand_height": number, "tempo_ratio": number, "issues": string[], "advice": string[]}',
    "Do not include any explanations or code fences. Values should reflect the overall swing across the frames.",
    meta
      ? `Player info: handedness=${meta.handedness}, clubType=${meta.clubType}, level=${meta.level}.`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");

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

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: unknown };
  const output = data.choices?.[0]?.message?.content;

  if (!output || typeof output !== "string") {
    throw new Error("OpenAI response did not include JSON text output");
  }

  return output.trim();
}
