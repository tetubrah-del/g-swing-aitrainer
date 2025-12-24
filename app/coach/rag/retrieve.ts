import fs from "node:fs";
import path from "node:path";

type RetrieveOptions = {
  maxChunks?: number;
  maxChars?: number;
  minScore?: number;
};

const KB_PATH = path.join(process.cwd(), "app", "coach", "rag", "KNOWLEDGE.md");

const safeReadText = (filePath: string): string => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

const normalize = (text: string) =>
  String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();

const tokenize = (text: string): string[] => {
  const t = normalize(text);
  if (!t) return [];
  // JP/EN mixed, crude tokens: kanji/hiragana/katakana/alnum (len>=2)
  const matches = t.match(/[一-龥ぁ-んァ-ンA-Za-z0-9]{2,}/g) ?? [];
  const stop = new Set(["この", "それ", "ため", "ので", "です", "ます", "する", "して", "ある", "ない", "こと", "もの"]);
  const out = matches
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 2 && s.length <= 32 && !stop.has(s));
  return Array.from(new Set(out));
};

const splitIntoChunks = (raw: string): string[] => {
  const text = normalize(raw);
  if (!text) return [];
  // Drop the top instruction header until the first horizontal rule or blank block.
  const stripped = text.replace(/^#.*\n+([\s\S]*?)\n---\n+/m, "");
  const blocks = stripped
    .split(/\n{2,}/)
    .map((b) => normalize(b))
    .filter(Boolean);
  // Merge very short blocks into neighbors to avoid noise.
  const merged: string[] = [];
  for (const b of blocks) {
    if (!merged.length) {
      merged.push(b);
      continue;
    }
    if (b.length < 80) {
      merged[merged.length - 1] = normalize(`${merged[merged.length - 1]}\n${b}`);
    } else {
      merged.push(b);
    }
  }
  return merged;
};

const scoreChunk = (chunk: string, queryTokens: string[]): number => {
  if (!chunk) return 0;
  if (!queryTokens.length) return 0;
  const c = chunk.toLowerCase();
  let hit = 0;
  for (const tok of queryTokens) {
    if (c.includes(tok)) hit += 1;
  }
  // Prefer smaller chunks when tied.
  const sizePenalty = Math.min(Math.max(chunk.length / 1200, 0), 1.5);
  return hit - sizePenalty;
};

export const retrieveCoachKnowledge = (
  query: string,
  opts: RetrieveOptions = {}
): { contextText: string; chunks: string[] } => {
  const maxChunks = Math.max(0, Math.min(opts.maxChunks ?? 4, 8));
  const maxChars = Math.max(200, Math.min(opts.maxChars ?? 1400, 4000));
  const minScore = opts.minScore ?? 1;

  const raw = safeReadText(KB_PATH);
  if (!raw.trim()) return { contextText: "", chunks: [] };

  const chunks = splitIntoChunks(raw);
  if (!chunks.length) return { contextText: "", chunks: [] };

  const qTokens = tokenize(query);
  if (!qTokens.length) return { contextText: "", chunks: [] };

  const ranked = chunks
    .map((c) => ({ c, score: scoreChunk(c, qTokens) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
    .map((x) => x.c);

  if (!ranked.length) return { contextText: "", chunks: [] };

  const outChunks: string[] = [];
  let total = 0;
  for (const c of ranked) {
    if (outChunks.length >= maxChunks) break;
    const nextTotal = total + c.length + (outChunks.length ? 2 : 0);
    if (nextTotal > maxChars) break;
    outChunks.push(c);
    total = nextTotal;
  }

  const contextText = outChunks.join("\n\n").slice(0, maxChars);
  return { contextText, chunks: outChunks };
};

