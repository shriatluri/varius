import { App } from '@slack/bolt';
import { loadRegistry } from './registry';
import { runAgent } from './runner';

const registry = loadRegistry();
process.on('SIGHUP', () => {
  console.error('SIGHUP: reloading registry');
  registry.reload();
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.message(async ({ message }) => {
  const m = message as {
    channel: string;
    ts: string;
    thread_ts?: string;
    text?: string;
    subtype?: string;
    bot_id?: string;
  };

  // Ignore bot messages (including our own) or build an infinite loop on day one (§9).
  if (m.subtype === 'bot_message' || m.bot_id) return;
  if (!m.text?.trim()) return;

  // Unknown channel → ignore silently (§3).
  const agent = registry.byChannel(m.channel);
  if (!agent || !agent.manifest.interactive) return;

  // A top-level message starts a thread keyed by its own ts.
  const threadTs = m.thread_ts ?? m.ts;
  try {
    await runAgent(agent, { trigger: 'slack', prompt: m.text, threadTs });
  } catch {
    // Already logged and reported to Slack by the runner; keep the bridge alive.
  }
});

(async () => {
  await app.start();
  console.error('bridge: connected over Socket Mode');
})();
