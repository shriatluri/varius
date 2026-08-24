import { App, BlockAction, ButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadRegistry } from './registry';
import { runAgent } from './runner';

const execFileP = promisify(execFile);

const registry = loadRegistry();
process.on('SIGHUP', () => {
  console.error('SIGHUP: reloading registry');
  registry.reload();
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  // Bolt drops the app's own events before any listener by default, which
  // would swallow voice-mode posts (jarvis.py posts AS the bot). Our handler
  // does its own bot filtering, with the varius_voice metadata exception.
  ignoreSelf: false,
});

app.message(async ({ message }) => {
  const m = message as {
    channel: string;
    ts: string;
    thread_ts?: string;
    text?: string;
    subtype?: string;
    bot_id?: string;
    metadata?: { event_type?: string };
  };

  // Only react to plain user messages. Ignore our own/other bots (infinite loop,
  // §9) AND every system event — channel_join, channel_name (rename), message_changed,
  // etc. A real user message has no subtype; anything with one is not a prompt and
  // can't be threaded-replied to (→ cannot_reply_to_message).
  // One exception: voice mode (scripts/jarvis.py) posts AS the bot, tagged with
  // message metadata. Agent replies carry no such tag, so the loop guard holds.
  const isVoice = m.metadata?.event_type === 'varius_voice';
  if (!isVoice && (m.subtype || m.bot_id)) return;
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

// Merge/Deny buttons posted by the runner (postPrReview). The button value is
// the PR URL; gh runs as the operator's auth, so merging stays a human click.
// Requires interactivity enabled on the Slack app (deploy/slack-manifest.yaml).
const PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

function prAction(kind: 'merge' | 'deny') {
  return async ({ ack, body, action, respond }: SlackActionMiddlewareArgs<BlockAction<ButtonAction>>) => {
    await ack();
    const user = body.user?.id;
    const prUrl = action.value;
    const operator = process.env.OPERATOR_USER;
    if (operator && user !== operator) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: `Only <@${operator}> can ${kind} from here.` });
      return;
    }
    if (!prUrl || !PR_URL_RE.test(prUrl)) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: ':warning: button carries no valid PR URL' });
      return;
    }
    try {
      if (kind === 'merge') {
        await execFileP('gh', ['pr', 'merge', prUrl, '--squash', '--delete-branch'], { timeout: 60_000 });
      } else {
        // Close but keep the branch — a thread follow-up may still amend it.
        await execFileP('gh', ['pr', 'close', prUrl, '--comment', 'Denied from Slack review.'], { timeout: 60_000 });
      }
      const verb = kind === 'merge' ? ':white_check_mark: Merged' : ':no_entry_sign: Denied';
      await respond({
        replace_original: true,
        text: `${verb} by <@${user}> — ${prUrl}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${verb} by <@${user}> — <${prUrl}|view PR>` } }],
      });
    } catch (err) {
      // One-line summary in Slack, full detail in the journal (§9). Buttons
      // stay in place so the click can be retried.
      console.error(`pr ${kind} failed for ${prUrl}`, err);
      await respond({ response_type: 'ephemeral', replace_original: false, text: `:warning: ${kind} failed for <${prUrl}|PR> — see \`journalctl -u fleet-bridge\`` });
    }
  };
}

app.action<BlockAction<ButtonAction>>('pr_merge', prAction('merge'));
app.action<BlockAction<ButtonAction>>('pr_deny', prAction('deny'));

(async () => {
  await app.start();
  console.error('bridge: connected over Socket Mode');
})();
