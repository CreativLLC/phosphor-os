#!/usr/bin/env node
// A stand-in for `hermes acp` (tests/hermeschat.ts): answers the ACP calls Phosphor-OS makes, with the update shapes
// a real Hermes Agent 0.23.2 sent (2026-11-17). Every message it gets is logged to FAKE_HERMES_LOG.
// A prompt holding "WAIT" runs until session/cancel. Any other prompt: a tool call, an OK request, a reply.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (m) => process.env.FAKE_HERMES_LOG && appendFileSync(process.env.FAKE_HERMES_LOG, JSON.stringify(m) + '\n');
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = (sessionId, u) => out({ method: 'session/update', params: { sessionId, update: u } });
const KNOWN = new Set(['local-saved-session-0001']);
let waiting; // a prompt waiting for session/cancel: its request id
let asked; // the OK request waiting for its answer: resolve

createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  log(m);
  if (m.method === undefined && m.id === 'p1') return asked?.(m.result);
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      return out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    case 'session/new':
      return out({ id: m.id, result: { sessionId: 'local-new-session-0002' } });
    case 'session/load':
      if (!KNOWN.has(p.sessionId)) return out({ id: m.id, error: { code: -32002, message: 'Session not found' } });
      update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed history' } });
      return out({ id: m.id, result: {} });
    case 'session/set_config_option':
    case 'session/set_model':
      return out({ id: m.id, result: {} });
    case 'session/cancel':
      if (waiting !== undefined) out({ id: waiting, result: { stopReason: 'cancelled' } });
      waiting = undefined;
      return;
    case 'session/prompt': {
      const text = p.prompt?.[0]?.text ?? '';
      const sid = p.sessionId;
      if (text.includes('WAIT')) return (waiting = m.id);
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'terminal: echo hi', kind: 'execute', content: [{ type: 'content', content: { type: 'text', text: '$ echo hi' } }] });
      new Promise((r) => {
        asked = r;
        out({ id: 'p1', method: 'session/request_permission', params: { sessionId: sid, options: [{ kind: 'allow_once', optionId: 'allow_once' }, { kind: 'reject_once', optionId: 'deny' }], toolCall: { title: 'terminal: echo hi', rawInput: { command: 'echo hi' } } } });
      }).then((answer) => {
        const ok = answer?.outcome?.optionId === 'allow_once';
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: ok ? 'hi' : 'denied' } }] });
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'write_file: /tmp/x.txt', kind: 'edit', rawInput: { path: '/tmp/x.txt' } });
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' });
        update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello ' } });
        update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'there' } });
        out({ id: m.id, result: { stopReason: 'end_turn' } });
      });
      return;
    }
    default:
      if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: 'unknown' } });
  }
});
