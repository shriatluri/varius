import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Slack blocks cap at 3000 chars; stay comfortably under.
const MAX_CHUNK = 2900;

/**
 * Convert standard/GitHub Markdown to Slack mrkdwn so posts render cleanly
 * instead of showing raw ** and [](). Slack mrkdwn is its own dialect: *bold*
 * (single asterisks), _italic_, <url|label> links, no #-headings, • bullets.
 * Fenced code blocks are left untouched. Models emit GitHub Markdown by
 * default, so this normalizes every agent's output in one place.
 */
export function toSlackMrkdwn(text: string): string {
  // Protect fenced code blocks (```…```) from all transforms below.
  const fences: string[] = [];
  let out = text.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });

  // Drop horizontal rules (---, ***, ___ on their own line) — no mrkdwn equiv.
  out = out.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');
  // Links: [label](url) -> <url|label>
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>');
  // Headings: leading #'s -> a bold line (Slack has no headings)
  out = out.replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*$/gm, '*$1*');
  // Bold: **text** or __text__ -> *text*
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  out = out.replace(/__([^_\n]+)__/g, '*$1*');
  // Bullets: leading "- " or "* " -> "• "
  out = out.replace(/^(\s*)[-*]\s+/gm, '$1• ');

  return out.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[Number(i)]);
}

/** Split on line boundaries into ≤MAX_CHUNK pieces; hard-split lines that are themselves too long. */
export function chunk(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const chunks: string[] = [];
  let current = '';
  for (let line of text.split('\n')) {
    while (line.length > MAX_CHUNK) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(line.slice(0, MAX_CHUNK));
      line = line.slice(MAX_CHUNK);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_CHUNK) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Post text to a channel, chunked to respect Slack limits.
 * With threadTs → threaded reply (inbound); without → top-level (scheduled digests).
 * Returns the ts of every message posted, in order. A long top-level post is
 * several messages, and a reply can thread under any of them.
 */
export async function postText(channel: string, text: string, threadTs?: string): Promise<string[]> {
  const posted: string[] = [];
  for (const part of chunk(toSlackMrkdwn(text))) {
    const res = await client.chat.postMessage({ channel, text: part, thread_ts: threadTs });
    if (res.ts) posted.push(res.ts);
  }
  return posted;
}

/**
 * Post Merge/Deny buttons for a PR an agent just opened. Clicks are handled in
 * bridge.ts (pr_merge / pr_deny) — merging stays a human action.
 */
export async function postPrReview(channel: string, prUrl: string, threadTs?: string): Promise<void> {
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Review: ${prUrl}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Review: <${prUrl}|open PR>` } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Merge' }, style: 'primary', action_id: 'pr_merge', value: prUrl },
          { type: 'button', text: { type: 'plain_text', text: 'Deny' }, style: 'danger', action_id: 'pr_deny', value: prUrl },
        ],
      },
    ],
  });
}
