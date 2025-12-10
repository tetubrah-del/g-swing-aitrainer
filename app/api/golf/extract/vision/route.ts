export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Vision プロンプト（精度最適化済）
const PROMPT = `
You are an expert golf swing analyst.

I will provide ~30 extracted frames from a golf swing video.
From these images, pick **exactly 1 best frame** for each phase:

1. address
2. backswing
3. top
4. downswing
5. impact
6. finish

Rules:
- Consider the *golf swing motion* and choose the frame that best represents each phase.
- If multiple frames look similar, choose the earliest one.
- Return ONLY JSON in the following format:

{
 "address": <index>,
 "backswing": <index>,
 "top": <index>,
 "downswing": <index>,
 "impact": <index>,
 "finish": <index>
}

No explanation. Only JSON.
`;

function parseJsonContent(content: string | null | undefined) {
  if (!content) {
    throw new Error("No content returned from vision model");
  }

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("Unable to parse JSON from vision response");
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

    // ▼ Vision API 正式対応パッチ
    const contentBlocks = [
      {
        type: "text",
        text: PROMPT,
      },
      ...frames.map((url: string) => ({
        type: "image_url",
        image_url: { url },
      })),
    ];

    const messages = [
      {
        role: "user",
        content: contentBlocks,
      },
    ];

    const result = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 300,
      temperature: 0.0,
    });

    const content = result.choices[0]?.message?.content?.toString().trim();
    const json = parseJsonContent(content);

    return NextResponse.json({ mapping: json });
  } catch (err: any) {
    console.error("[vision extract]", err);
    return NextResponse.json(
      { error: "vision processing failed", detail: err?.message },
      { status: 500 }
    );
  }
}
