// Mission panel CONNECTORS: counting a chat's connector calls and merging Claude Code's server list (server/tab.ts).
//   npx tsx tests/connectors.ts

import type { Connector } from '../shared/protocol.ts';
import { countConnector, mergeConnectors } from '../server/tab.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};

const list: Connector[] = [];
check('built-in tool: not a connector', !countConnector(list, 'Bash') && !list.length);
check("the app's own mission tool: not a connector", !countConnector(list, 'mcp__phosphor__update_mission') && !list.length);
countConnector(list, 'mcp__claude_ai_Gmail__search_threads');
countConnector(list, 'mcp__claude_ai_Gmail__get_thread');
countConnector(list, 'mcp__playwright__browser_navigate');
check('calls counted per server (by tool-name key before the list is known)', list.length === 2 && list[0].calls === 2 && list[0].name === 'claude_ai_Gmail', JSON.stringify(list));

const merged = mergeConnectors(list, [
  { name: 'phosphor', status: 'connected' },
  { name: 'claude.ai Gmail', status: 'connected' },
  { name: 'claude.ai Notion', status: 'needs-auth' },
]);
const gmail = merged.find((c) => c.name === 'claude.ai Gmail');
check("Claude Code's names replace the keys; the calls carry over", gmail?.calls === 2 && gmail.status === 'connected', JSON.stringify(merged));
check('a server never used: 0 calls; the own server left out', merged.find((c) => c.name === 'claude.ai Notion')?.calls === 0 && !merged.some((c) => c.name === 'phosphor'));
check('a used server missing from the list (removed since) is kept', merged.some((c) => c.name === 'playwright' && c.calls === 1), JSON.stringify(merged));
countConnector(merged, 'mcp__claude_ai_Gmail__label_thread');
check('a later call finds the server by its real name', merged.find((c) => c.name === 'claude.ai Gmail')?.calls === 3);

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
