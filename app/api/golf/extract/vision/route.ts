export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Vision はフェーズ判定をせず、ポーズ・キーポイント抽出のみを行う
const PROMPT = `
You are a vision model. Extract human pose keypoints and club shaft vector for each image. Do NOT classify swing phases.

For EACH input image, return an object with:
- idx: the image index (0-based, same order as provided)
- pose: { leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist, leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle } with x,y in normalized [0,1] coordinates (origin = top-left of image)
- club: { shaftVector: [dx, dy] } where dx,dy is a unit-ish 2D vector pointing from grip to clubhead; if unknown, set shaftVector: null

Output JSON only in this shape:
{ "frames": [ { "idx": 0, "pose": { ... }, "club": { "shaftVector": [dx, dy] | null } }, ... ] }

Do not add explanations.`;

function parseJsonContent(content: unknown) {
  if (content === null || content === undefined) {
    return {};
  }

  if (typeof content === "object") return content;

  const text = String(content).trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("[vision parse json failed]", text.slice(0, 500), err);
    return {};
  }
}

export async function POST(req: Request) {
  try {
    const { frames } = await req.json();
    if (!frames || !Array.isArray(frames)) {
      return NextResponse.json(
        { error: "frames array is required" },
        { status: 400 }
      );
    }

    if (!frames.length) {
      return NextResponse.json(
        { error: "frames must contain at least one image" },
        { status: 400 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const normalizedFrames: Array<{ url: string; timestampSec?: number }> = frames.map((f: any) => {
      if (typeof f === "string") return { url: f, timestampSec: undefined };
      if (f && typeof f === "object" && typeof f.url === "string") {
        return { url: f.url, timestampSec: typeof f.timestampSec === "number" ? f.timestampSec : undefined };
      }
      return { url: String(f ?? "") };
    });

    // フレームが多いと Vision への data URL 送信でトークン超過しやすいので上限を設けて間引く
    // 429 (TPM) を避けるため画像枚数を厳しめに制限しつつ、最終フレームは必ず含める
    const MAX_FRAMES = 18;
    const stride = Math.max(1, Math.ceil(normalizedFrames.length / MAX_FRAMES));
    const sampledFrames = normalizedFrames
      .filter((_: unknown, idx: number) => idx % stride === 0)
      .slice(0, MAX_FRAMES);
    const last = normalizedFrames[normalizedFrames.length - 1];
    if (last && !sampledFrames.includes(last)) sampledFrames.push(last);

    // ダウンロード不可な相対URLやローカルURLを Vision に渡さないよう、サーバー側で画像を取得して data URL 化する
    const imageContents = [];
    for (const item of sampledFrames) {
      const url = item.url;
      try {
        const absolute = new URL(url, req.url).toString();
        const response = await fetch(absolute);
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        const mime = response.headers.get("content-type") || "image/jpeg";
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        imageContents.push({
          type: "image_url" as const,
          image_url: { url: `data:${mime};base64,${base64}`, detail: "low" as const },
        });
      } catch (err) {
        console.error("[vision fetch image failed]", url, err);
      }
    }

    if (!imageContents.length) {
      return NextResponse.json(
        { error: "frames could not be loaded" },
        { status: 400 }
      );
    }

    // ▼ Vision API へポーズ抽出だけを依頼
    const contentBlocks = [
      {
        type: "text",
        text: PROMPT,
      },
      ...imageContents.flatMap((ic, idx) => [
        {
          type: "text" as const,
          text: `frame #${idx}`,
        },
        ic,
      ]),
    ];

    const messages = [
      {
        role: "user" as const,
        content: contentBlocks as unknown,
      },
    ] as const;

    const result = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages as any,
      max_tokens: 800,
      temperature: 0.0,
      response_format: { type: "json_object" },
    });

    // OpenAI SDK v4 returns structured_object when using response_format json_object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const structured = (result as any).choices?.[0]?.message?.parsed ?? result.choices?.[0]?.message?.content;
    const json = parseJsonContent(structured);

    return NextResponse.json({ keypoints: json });
  } catch (err) {
    console.error("[vision extract]", err);
    const detail = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
    return NextResponse.json({ error: "vision processing failed", detail }, { status: 500 });
  }
}
