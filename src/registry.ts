import * as fs from 'node:fs';
import * as path from 'node:path';
import { Agent, AgentManifest } from './types';

const AGENTS_ROOT = path.resolve(__dirname, '..', 'agents');
const ID_RE = /^[a-z][a-z0-9-]*$/;

function validate(manifest: AgentManifest, dir: string): string | null {
  const id = path.basename(dir);
  if (manifest.id !== id) return `id "${manifest.id}" != folder name "${id}"`;
  if (!ID_RE.test(manifest.id)) return `id must be lowercase-hyphen`;
  if (!manifest.channel?.startsWith('C')) return `channel must be a Slack channel ID (C…)`;
  if (!['sonnet', 'haiku', 'opus'].includes(manifest.model)) return `bad model "${manifest.model}"`;
  if (!Array.isArray(manifest.allowedTools)) return `allowedTools must be an array`;
  if (!Number.isInteger(manifest.maxTurns) || manifest.maxTurns < 1) return `maxTurns required`;
  if (!Number.isInteger(manifest.timeoutSec) || manifest.timeoutSec < 1) return `timeoutSec required`;
  if (manifest.schedule && !fs.existsSync(path.join(dir, manifest.schedule.prompt)))
    return `schedule.prompt "${manifest.schedule.prompt}" not found`;
  if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) return `CLAUDE.md missing`;
  return null;
}

export class Registry {
  private byIdMap = new Map<string, Agent>();
  private byChannelMap = new Map<string, Agent>();

  constructor(private root = AGENTS_ROOT) {
    this.reload();
  }

  reload(): void {
    this.byIdMap.clear();
    this.byChannelMap.clear();
    if (!fs.existsSync(this.root)) return;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const dir = path.join(this.root, entry.name);
      const manifestPath = path.join(dir, 'agent.json');
      if (!fs.existsSync(manifestPath)) continue;
      let manifest: AgentManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        console.error(`registry: skipping ${entry.name}: unparseable agent.json (${e})`);
        continue;
      }
      const problem = validate(manifest, dir);
      if (problem) {
        console.error(`registry: skipping ${entry.name}: ${problem}`);
        continue;
      }
      const agent: Agent = { manifest, dir };
      this.byIdMap.set(manifest.id, agent);
      this.byChannelMap.set(manifest.channel, agent);
    }
    console.error(`registry: ${this.byIdMap.size} agent(s) loaded`);
  }

  byId(id: string): Agent | undefined {
    return this.byIdMap.get(id);
  }

  byChannel(channel: string): Agent | undefined {
    return this.byChannelMap.get(channel);
  }

  all(): Agent[] {
    return [...this.byIdMap.values()];
  }
}

export function loadRegistry(root?: string): Registry {
  return new Registry(root);
}
