import type { SdkUpdate } from '../../shared/protocol.ts';
import { store } from './store.ts';
import { confirmBox, toast } from './ui.ts';

// UPDATE chip in the top bar (left of LAUNCH): a newer Claude Code (Agent SDK) waits. Click: confirm, then
// POST /api/update (server/sdkupdate.ts runs scripts/update-sdk.sh and restarts the app). A busy chat makes the
// server refuse; the box then offers UPDATE ANYWAY. The server sends the state on connect and on every change.

const BIGGER = 'A bigger update is also out; it needs a code check first and is not installed by this button.';

export function mountUpdate(btn: HTMLButtonElement): void {
  let state: SdkUpdate | undefined;
  let asking = false;

  const draw = () => {
    const s = state;
    btn.hidden = !s || (!s.pending && !s.running);
    if (!s) return;
    const v = s.claude ?? s.pending ?? '';
    btn.textContent = s.running ? 'UPDATING…' : `UPDATE ${v}`;
    btn.disabled = s.running;
    btn.title = s.running
      ? 'Updating Claude Code. The app restarts when it is done.'
      : `Claude Code ${v} is ready.${s.failed ? ' The last try failed (see data/update.log).' : ''}${s.bigger ? ` ${BIGGER}` : ''}`;
  };

  store.on((c) => {
    if (c.kind !== 'sdk_update') return;
    state = c.state;
    draw();
  });

  const post = async (force: boolean) => {
    const r = await fetch(`/api/update${force ? '?force=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as { error?: string } };
  };

  btn.onclick = async () => {
    const s = state;
    if (!s?.pending || s.running || asking) return;
    if (store.demo) return toast('Demo: nothing is updated.');
    asking = true;
    try {
      const v = s.claude ?? s.pending;
      if (!(await confirmBox('UPDATE CLAUDE CODE', `Update to ${v}? The app restarts after and your chats come back.${s.bigger ? ` ${BIGGER}` : ''}`, 'UPDATE'))) return;
      let r = await post(false);
      if (r.status === 409 && (await confirmBox('NOT NOW', `${r.body.error ?? 'A chat is busy.'}`, 'UPDATE ANYWAY'))) r = await post(true);
      if (r.status !== 200) toast(r.status === 409 ? 'Update not started.' : (r.body.error ?? 'Update not started.'));
    } catch {
      toast('Could not reach the server.');
    } finally {
      asking = false;
    }
  };
}
