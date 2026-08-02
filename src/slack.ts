import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Slack blocks cap at 3000 chars; stay comfortably under.
const MAX_CHUNK = 2900;

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
 * Returns the ts of the first message posted.
 */
export async function postText(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
  let firstTs: string | undefined;
  for (const part of chunk(text)) {
    const res = await client.chat.postMessage({ channel, text: part, thread_ts: threadTs });
    firstTs ??= res.ts as string | undefined;
  }
  return firstTs;
}
