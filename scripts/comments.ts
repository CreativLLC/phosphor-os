// YouTube comments from the command line (docs/COMMENTS.md). Claude runs this to read the inbox the server keeps in
// data/comments/ (the server does the checking; this reads its store). Drafts are printed, not saved.
//   npx tsx scripts/comments.ts unanswered [--json]       comments the channel has not answered, newest first
//   npx tsx scripts/comments.ts list [--video <id>] [--json]   every comment
//   npx tsx scripts/comments.ts draft <comment id>        a reply in the owner's voice (printed)
//   npx tsx scripts/comments.ts status [--json]           sign-in, last check, quota used today
//   npx tsx scripts/comments.ts reply <comment id> "text" --send   posts ONE reply after you type "send" (50 quota units)
import { createInterface } from 'node:readline/promises';
import type { CommentView } from '../shared/comments.ts';
import { commentsApp } from '../server/comments.ts';

const args = process.argv.slice(2);
const has = (f: string) => {
  const i = args.indexOf(f);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return '';
  const v = args[i + 1] ?? '';
  args.splice(i, 2);
  return v;
};
const asJson = has('--json');
const send = has('--send');
const video = flag('--video');
const [cmd, id, ...rest] = args;

const c = commentsApp(true); // read-only: the running server owns the store
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function show(items: CommentView[], videos: Record<string, { title: string }>): void {
  if (asJson) return console.log(JSON.stringify(items.map((x) => ({ ...x, video: videos[x.videoId]?.title ?? '' })), null, 1));
  if (!items.length) return console.log('(none)');
  for (const x of items) {
    const tags = [x.own ? 'YOU' : '', x.answered ? 'ANSWERED' : 'UNANSWERED', x.isReply ? 'REPLY' : '', x.read ? '' : 'NEW', x.likes ? `${x.likes} likes` : ''].filter(Boolean).join(', ');
    console.log(`${x.id}  ${when(x.at)}  ${x.author}  [${tags}]\n  on: ${videos[x.videoId]?.title ?? x.videoId}\n  ${x.text.replace(/\n/g, '\n  ')}${x.draft ? `\n  draft: ${x.draft}` : ''}\n  ${x.url}\n`);
  }
}

switch (cmd) {
  case 'unanswered':
  case 'list': {
    const l = c.list(cmd === 'list' ? 'all' : 'unanswered', video);
    show(l.items, l.videos);
    if (!asJson && !l.status.lastCheck) console.log('Never checked yet. Is the server running and signed in? See the COMMENTS screen.');
    break;
  }
  case 'status': {
    const s = c.status();
    if (asJson) console.log(JSON.stringify(s, null, 1));
    else {
      console.log(`signed in: ${s.signedIn ? 'yes' : s.configured ? 'no (sign in on the COMMENTS screen)' : 'no (client id and secret missing in .env)'}`);
      if (s.channel) console.log(`channel: ${s.channel.title}`);
      console.log(`last check: ${s.lastCheck ? when(s.lastCheck) : 'never'}${s.lastError ? `  (error: ${s.lastError})` : ''}`);
      console.log(`unanswered: ${s.counts.unanswered}, new: ${s.counts.unread}, all: ${s.counts.all}, hidden: ${s.counts.hidden}`);
      console.log(`quota today (${s.quota.day}, Pacific): ${s.quota.units} of ${s.quota.limit} units  ${JSON.stringify(s.quota.calls)}`);
    }
    break;
  }
  case 'draft': {
    if (!id || !c.get(id)) {
      console.error('usage: npx tsx scripts/comments.ts draft <comment id>   (ids: the unanswered list)');
      process.exit(2);
    }
    const d = await c.draft(id);
    console.log(asJson ? JSON.stringify(d) : `${d.text}\n\n(by ${d.by}; not saved and not sent. Send it from the COMMENTS screen.)`);
    break;
  }
  case 'reply': {
    const text = rest.join(' ').trim();
    const target = id ? c.get(id) : null;
    if (!target || !text || !send) {
      console.error('usage: npx tsx scripts/comments.ts reply <comment id> "reply text" --send   (asks before posting)');
      process.exit(2);
    }
    console.log(`Reply to ${target.author}: ${target.text.slice(0, 200)}\n\nYour reply:\n${text}\n`);
    if (/[—–]/.test(text)) console.log('Note: the reply has a long dash (— or –).');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question('Type "send" to post it on YouTube: ')).trim().toLowerCase() === 'send';
    rl.close();
    if (!ok) {
      console.log('Not sent.');
      process.exit(1);
    }
    const r = await c.reply(id, text);
    console.log(`Posted: ${r.id}. The COMMENTS screen shows the thread as answered.`);
    break;
  }
  default:
    console.error('usage: npx tsx scripts/comments.ts unanswered|list [--video <id>]|status|draft <id>|reply <id> "text" --send  [--json]');
    process.exit(2);
}
process.exit(0);
