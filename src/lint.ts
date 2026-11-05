import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadRegistry } from './registry';
import { AgentManifest } from './types';

// Grant lint: the allowedTools gotchas from CLAUDE.md as checks. Agent folders
// are gitignored, so this runs against the box's real agents/ (laptop and VPS),
// not in CI; test/lint.test.ts covers the rules themselves.

export interface Finding {
  level: 'error' | 'warn';
  message: string;
}

// Bash grants that hand the agent an interpreter, the network, or a shell:
// with any of them the rest of the allowlist is decoration.
const OPEN_BASH = /^Bash(\((\*|(curl|wget|bash|sh|zsh|node|npx|python3?|perl|ruby|env|eval|xargs|sudo)\b.*)\))?$/;

export function lintManifest(m: AgentManifest, dir: string): Finding[] {
  const tools = m.allowedTools;
  const out: Finding[] = [];
  const error = (message: string) => out.push({ level: 'error', message });
  const warn = (message: string) => out.push({ level: 'warn', message });
  const hasEdit = tools.some((t) => t === 'Edit' || t.startsWith('Edit('));

  for (const t of tools) {
    if (OPEN_BASH.test(t)) error(`${t}: interpreter/network/shell grant; wrap the call in a ./helper.sh and grant that`);
    if (/^Bash\(git \*\)$/.test(t)) warn(`${t}: allows \`git -c core.hooksPath=…\` / \`git config\`, i.e. arbitrary code; grant subcommands`);
    if (/^Bash\(cd\b/.test(t)) warn(`${t}: the CLI blocks \`cd X && git …\` anyway; prefer \`git -C <dir>\``);
    // Write(path) rules are accepted but never consulted: Edit(path) governs.
    const w = t.match(/^Write\((.+)\)$/);
    if (w && !tools.includes(`Edit(${w[1]})`)) error(`${t}: Write(path) rules are never consulted; use Edit(${w[1]})`);
  }
  if (tools.includes('Write') && !hasEdit)
    warn('bare Write without Edit: creating works, then overwriting the file is denied from run two');
  if (tools.includes('Read') && (tools.includes('WebFetch') || tools.some((t) => OPEN_BASH.test(t))))
    warn('unscoped Read + an outbound tool: a prompt-injected page can read secrets and send them out; scope Read(...)');

  const mcpPath = path.join(dir, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    let servers: string[] = [];
    try { servers = Object.keys(JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers ?? {}); }
    catch { error('.mcp.json is not valid JSON'); }
    for (const s of servers) {
      if (!tools.some((t) => t === `mcp__${s}` || t.startsWith(`mcp__${s}__`)))
        error(`.mcp.json loads "${s}" but no mcp__${s} grant: every call is silently denied in -p mode`);
    }
  }
  return out;
}

if (require.main === module) {
  let errors = 0;
  for (const agent of loadRegistry().all()) {
    for (const f of lintManifest(agent.manifest, agent.dir)) {
      if (f.level === 'error') errors++;
      console.log(`${f.level.padEnd(5)} ${agent.manifest.id}: ${f.message}`);
    }
  }
  process.exit(errors > 0 ? 1 : 0);
}
