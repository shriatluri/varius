/**
 * Markdown → retrievable sections.
 *
 * A chunk is a heading's section, not a fixed window: a hit comes back as a
 * coherent unit that carries its own title, which is what makes a search
 * result usable without a follow-up read. Sections longer than the ceiling
 * split at paragraph boundaries and keep the heading path.
 */

/** ~4 chars per token is close enough for a budget we only need to not blow. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MAX_CHUNK_TOKENS = 700;

export interface Chunk {
  /** "Memory › TODO.md" style trail of enclosing headings; empty for a preamble. */
  heading: string;
  /** 0-based position within the file, for stable ordering and ids. */
  ord: number;
  text: string;
  tokens: number;
  line: number;
}

interface Section {
  headingPath: string[];
  lines: string[];
  line: number;
}

const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

function splitSections(markdown: string): Section[] {
  const out: Section[] = [];
  const path: string[] = [];
  let current: Section = { headingPath: [], lines: [], line: 1 };
  let inFence = false;

  markdown.split('\n').forEach((raw, i) => {
    if (FENCE.test(raw)) inFence = !inFence;
    const match = inFence ? null : raw.match(ATX);
    if (!match) {
      current.lines.push(raw);
      return;
    }
    if (current.lines.some((l) => l.trim())) out.push(current);
    const depth = match[1].length;
    path.length = Math.min(path.length, depth - 1);
    path[depth - 1] = match[2].trim();
    const headingPath = path.slice(0, depth).filter(Boolean);
    current = { headingPath, lines: [raw], line: i + 1 };
  });
  if (current.lines.some((l) => l.trim())) out.push(current);
  return out;
}

/** Break an oversized section at blank lines, never mid-paragraph. */
function packParagraphs(lines: string[]): string[][] {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (!line.trim() && paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
    else paragraphs[paragraphs.length - 1].push(line);
  }

  const packs: string[][] = [];
  let pack: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue;
    const merged = [...pack, ...paragraph];
    if (pack.length > 0 && estimateTokens(merged.join('\n')) > MAX_CHUNK_TOKENS) {
      packs.push(pack);
      pack = paragraph;
    } else {
      pack = merged;
    }
  }
  if (pack.length > 0) packs.push(pack);
  return packs;
}

export function chunkMarkdown(markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of splitSections(markdown)) {
    const heading = section.headingPath.join(' › ');
    const packs = estimateTokens(section.lines.join('\n')) > MAX_CHUNK_TOKENS
      ? packParagraphs(section.lines)
      : [section.lines];
    for (const pack of packs) {
      const text = pack.join('\n').trim();
      if (!text) continue;
      chunks.push({ heading, ord: chunks.length, text, tokens: estimateTokens(text), line: section.line });
    }
  }
  return chunks;
}
