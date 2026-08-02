import { loadRegistry } from './registry';
import { runAgent, scheduledPrompt } from './runner';
import { postText } from './slack';

function usage(): never {
  console.error('usage: cli.ts post <agent-id> <text…>   post as the bot to an agent channel');
  console.error('       cli.ts agent <agent-id> [prompt]  run an agent once (scheduled path)');
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, id, ...rest] = process.argv.slice(2);
  if (!cmd || !id) usage();

  const registry = loadRegistry();
  const agent = registry.byId(id);
  if (!agent) {
    console.error(`unknown agent "${id}" — known: ${registry.all().map((a) => a.manifest.id).join(', ') || '(none)'}`);
    process.exit(1);
  }

  switch (cmd) {
    case 'post': {
      const text = rest.join(' ');
      if (!text) usage();
      await postText(agent.manifest.channel, text);
      console.error(`posted to ${agent.manifest.channel}`);
      break;
    }
    case 'agent': {
      // Inline prompt overrides the scheduled one — handy for smoke tests.
      const prompt = rest.length > 0 ? rest.join(' ') : scheduledPrompt(agent);
      await runAgent(agent, { trigger: 'schedule', prompt });
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
