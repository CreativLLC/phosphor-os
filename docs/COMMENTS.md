# COMMENTS: your YouTube comments inbox

Every comment and reply on your channel's videos and Shorts in one list, the ones you have not answered first. The server checks YouTube on a timer and alerts you about new ones. A button drafts a reply in your voice; you edit it and press SEND. Nothing is ever posted without that press, and only one reply at a time.

## Use it

- **Screen:** MENU > COMMENTS (launcher: COMMENTS, COMMENTS STATS). Deep links: `/?comments`, `/?comments=stats`, `/?comments=setup`. A tap on a COMMENTS alert opens it.
  - **INBOX:** UNANSWERED (the default), ALL, HIDDEN, and one video at a time. Each card: author, time, likes, the text, the video (thumbnail and title), OPEN ON YOUTUBE, READ / UNREAD, HIDE / UNHIDE, REPLY. REPLY opens a box: DRAFT writes a reply (the local model when it is already in memory, else Claude Haiku: the CLEAN UP path), you edit it, SEND asks once more and posts it. The draft is saved as you type, so it is there on the phone too.
  - **STATS:** subscribers, total views, and the 10 newest videos with views, likes and comments (tap a comment count to see that video's comments).
  - **SETUP:** sign in or out, how often to check (5 min to 4 h, default 15 min), alerts on or off, quota used today.
- **Command line (and Claude):** `npx tsx scripts/comments.ts unanswered` (or `list [--video <id>]`, `status`, `draft <id>`, all with `--json`). `draft` prints a reply and saves nothing. Posting from the command line needs `reply <id> "text" --send` and typing `send` at the question; normally reply from the screen.
- **Alerts:** a desktop note on this PC, and a push to every phone or browser with ALERTS on and COMMENTS ticked (SETTINGS > ALERTS). Quiet hours apply to the push. The very first check after signing in does not alert (everything would be "new").

## Set it up (once)

You need a Google Cloud project of your own: it is free and only you use it.

1. Open https://console.cloud.google.com and sign in with the Google account that owns the YouTube channel.
2. Top bar: the project picker > **New project**. Any name (for example "Phosphor Comments"). **Create**, then pick it in the project picker.
3. Menu > **APIs & Services** > **Library**. Search **YouTube Data API v3**, open it, **Enable**.
4. Menu > **APIs & Services** > **OAuth consent screen** (it opens "Google Auth Platform"). **Get started**: app name (anything), your email as support email, **Next**. Audience: **External**, **Next**. Contact email: yours. Agree, **Create**.
5. Left side **Data Access** > **Add or remove scopes**. In the filter type `youtube.force-ssl`, tick `.../auth/youtube.force-ssl`, **Update**, then **Save**.
6. Left side **Audience**. Under "Publishing status" press **Publish app** and confirm, so it says **In production** (why: see the trap below). If you would rather stay in Testing, add your own Google account under **Test users** instead.
7. Left side **Clients** > **Create client**. Application type: **Desktop app**. Any name. **Create**. Copy the **Client ID** and the **Client secret**.
8. Open `.env` in the Phosphor-OS folder and fill in `PHOSPHOR_YOUTUBE_CLIENT_ID=` and `PHOSPHOR_YOUTUBE_CLIENT_SECRET=` with the two values. Restart the server (`systemctl --user restart phosphor-os-server`).
9. **On this PC** (not the phone), open Phosphor-OS > MENU > COMMENTS > SETUP > **SIGN IN WITH GOOGLE**. Pick the account (if the channel is a brand account, pick the channel). Google says "Google hasn't verified this app": it is your own app, press **Advanced**, then **Go to (your app name)**. Allow YouTube access. The tab says **SIGNED IN**; close it. The first check runs a few seconds later.

Optional, in `.env`: `PHOSPHOR_COMMENTS_VOICE` (files that describe how you write, for the drafts) and `PHOSPHOR_COMMENTS_NEVER` (words a draft must never hold, like your employer's name).

Sign-in on a phone: Google sends the browser back to `http://127.0.0.1:<port>/...`, which a phone cannot open. Copy that address from the phone's address bar and paste it in SETUP under the SIGN IN button, then FINISH.

## The Google trap: "Testing" sign-ins end after 7 days

Google's rules (checked 2026-10-29 against developers.google.com/identity/protocols/oauth2 and support.google.com/cloud/answer/15549945):

- An app whose consent screen is **External** and in **Testing** gets refresh tokens that **expire 7 days** after you allow it (only plain sign-in scopes, name and email, are spared). YouTube scopes are not spared, so in Testing you sign in again every week.
- An app **In production** has no such limit (a refresh token still ends when you revoke it, change your password in some cases, or leave it unused for 6 months). Production apps that use sensitive scopes without Google's verification show the "Google hasn't verified this app" screen and may get at most **100 new users**. Verification is only needed to get rid of that screen or go past 100 users.
- **Picked for you: publish to production and skip verification.** One user, you, clicks past the warning once. No weekly sign-in.
- Not verified here (untested): whether Google classes `youtube.force-ssl` as sensitive or restricted today (third-party guides disagree; restricted would also block unverified use), and whether "Publish app" lets you through without starting verification. If either blocks you, stay in Testing (step 6, test user) and sign in again weekly: when Google ends the sign-in, SETUP says so, the inbox keeps what it has, and checks stop until you sign in again.
- `youtube.force-ssl` is the scope the comments.insert docs list; it also covers reading. There is no narrower scope that can post a reply.

## Quota

YouTube Data API v3: 10,000 units a day for the whole project, reset at midnight Pacific time. Costs (developers.google.com/youtube/v3/determine_quota_cost): every list call 1 unit, comments.insert (a reply) 50.

| What | Units | A day (15 min checks) |
|---|---|---|
| Check: commentThreads.list (100 threads a page; stops at the first page that has a thread it saw before) | 1 a page | 96 |
| Deeper check every 6 hours (up to 20 pages, finds new replies on older threads) | 1 a page | 4 to 80 |
| comments.list for a thread with more replies than the check brought | 1 | a few |
| videos.list for videos it has not seen yet (50 a call) | 1 | 0 to 1 |
| STATS (cached 30 min, only when opened) | 3 | under 50 |
| A reply | 50 | 100 replies = 5,000 |

About 100 to 250 units a day before replies, so roughly 150 replies a day still fit. Every call is logged in `data/comments/quota.jsonl` (time, method, units; 30 days kept), shown in SETUP and in `scripts/comments.ts status`, and each check writes one line to the server log. Checks pause at 8,000 units a day so replies still go.

## Files

| What | Where |
|---|---|
| Inbox, checks, alerts, drafts, replies, HTTP | `server/comments.ts` (routes and types in `shared/comments.ts`) |
| Google sign-in (desktop app, loopback, PKCE) and API calls, quota log | `server/youtube.ts` |
| Command line | `scripts/comments.ts` |
| Screen | `web/src/comments.ts`, `web/src/comments.css`, demo data `web/src/commentsdemo.ts` (`/?demo=1&comments`) |
| Comments, marks, drafts, settings | `data/comments/store.json` (0600) |
| Sign-in (refresh token) | `data/comments/token.json` (0600; never sent to the page, a log or a chat) |
| Quota log, replies sent from the CLI | `data/comments/quota.jsonl`, `data/comments/sent.jsonl` |
| Tests | `npx tsx tests/comments.ts` (fake Google, temp folders, no network) |

## Notes and limits

- Only published comments. Comments YouTube holds for review or as likely spam are not fetched (that needs `moderationStatus`, a second list per check). Later, if wanted.
- A comment deleted on YouTube stays here (hide it).
- "Answered" means the channel wrote in the same thread after that comment. A reply to a reply goes to the thread's top comment (YouTube has one level); its draft starts with the person's @handle.
- Shorts and long videos look the same to the API; the title tells them apart.
- STATS uses the Data API only. Watch time, impressions and traffic sources need the YouTube Analytics API and its own scope (`yt-analytics.readonly`): not in this version.
- The sign-in callback (`/api/comments/auth/callback`) works without the login cookie, because the browser coming back from Google may be on `127.0.0.1` while the app runs on `localhost`. It only accepts a one-time state that a logged-in page started in the last 15 minutes. Everything else under `/api/comments` needs the login like every other route.
