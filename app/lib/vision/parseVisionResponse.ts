export type RawSwingMetrics = {
  impact_face_angle: number;
  club_path: number;
  body_open_angle: number;
  hand_height: number;
  tempo_ratio: number;
  issues: string[];
  advice: string[];
};

export const visionResponseSchema = {
  type: "object",
  properties: {
    impact_face_angle: { type: "number" },
    club_path: { type: "number" },
    body_open_angle: { type: "number" },
    hand_height: { type: "number" },
    tempo_ratio: { type: "number" },
    issues: { type: "array", items: { type: "string" } },
    advice: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
} as const;

function ensureNumber(value: unknown, field: string): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`Field ${field} must be a finite number`);
  }
  return num;
}

function ensureStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Field ${field} must be an array of strings`);
  }
  const strings = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`Field ${field} must be an array of strings`);
    }
    return entry;
  });
  return strings;
}

export function parseVisionResponse(rawText: string): RawSwingMetrics {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Failed to parse Vision API JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Vision API response is not an object");
  }

  const record = parsed as Record<string, unknown>;

  return {
    impact_face_angle: ensureNumber(record.impact_face_angle, "impact_face_angle"),
    club_path: ensureNumber(record.club_path, "club_path"),
    body_open_angle: ensureNumber(record.body_open_angle, "body_open_angle"),
    hand_height: ensureNumber(record.hand_height, "hand_height"),
    tempo_ratio: ensureNumber(record.tempo_ratio, "tempo_ratio"),
    issues: ensureStringArray(record.issues, "issues"),
    advice: ensureStringArray(record.advice, "advice"),
  };
}
