import { mountCleanup } from './cleanup.ts';
import { isDictating, stopDictation, useDictation } from './voice.ts';
import { button, el } from './ui.ts';

// The optional first message in the NEW CHAT and NEW PROJECT dialogs: type it or dictate it (DICTATE, CLEAN UP). It
// is not sent: when the chat opens, the text waits in its message box, so you read it and press SEND.
// (To send it at once instead, send({ t: 'send', tab, text }) in `hand` where it sets the box.)

export type FirstMessage = {
  block: HTMLElement;
  // Call when the dialog is about to start the chat: stops a running dictation and waits for its words, then gives what
  // to run when the new chat is open (newReq's `then`), or undefined when the box is empty. null: do not start (a
  // second tap while it waited, or the dialog was closed or turned into NEW PROJECT meanwhile).
  take: () => Promise<((tab: string) => void) | undefined | null>;
};

export function firstMessage(dialog: HTMLDialogElement, where: string): FirstMessage {
  const box = el('textarea');
  box.rows = 3;
  box.placeholder = `Type or dictate. Nothing is sent: it waits in the new ${where}'s message box.`;
  const dictate = button('DICTATE', () => {});
  const clean = button('CLEAN UP', () => {});
  const tools = el('div', 'first-msg-tools');
  tools.append(dictate, clean);
  const block = el('div', 'first-msg');
  block.append(el('div', 'set-label', 'FIRST MESSAGE (OPTIONAL)'), box, tools);

  // The one voice engine and the clean-up button belong to this box while the dialog is open.
  const release = useDictation(dictate, box, true);
  const dispose = mountCleanup(clean, box);
  dialog.addEventListener(
    'close',
    () => {
      release();
      dispose();
    },
    { once: true },
  );

  let taking = false;
  return {
    block,
    take: async () => {
      if (taking) return null;
      taking = true;
      // A running dictation ends and its words go in first, also a slow CLEAN UP AFTER DICTATING: unlike SEND (6 s at
      // most), this waits, because closing the dialog drops words that are not in the box yet. Esc skips a clean-up.
      while (isDictating()) await stopDictation();
      if (!dialog.open || !dialog.contains(block)) return null;
      const text = box.value.trim();
      if (!text) return undefined;
      return () => {
        // The new chat is the active one now and its message box is empty: put the text there, as a saved draft.
        const input = document.getElementById('input') as HTMLTextAreaElement | null;
        if (!input) return;
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
    },
  };
}
