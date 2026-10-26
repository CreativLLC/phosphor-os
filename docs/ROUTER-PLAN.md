# Router: plan

Owner's ask (2026-10-25): use the local models for the work they can do, pass work on as needed, keep a cloud orchestrator, and spend fewer plan tokens. Status: v1 built on branch `night2/router`.

## The idea

The cloud chat stays the orchestrator: it plans, decides and checks. It gets ways to hand work to cheaper workers, so big reads and routine work do not use Claude tokens. Claude decides per job; the app only offers the workers, keeps them safe on the GPU, and counts what they did.

Why not route whole messages to a local model instead (AUTO picking LOCAL)? See "AUTO and LOCAL" below: switching a running chat between Claude and a local model is not clean, so v1 routes jobs, not messages.

## The parts

| Part | What | Where |
|---|---|---|
| `ask_local` tool | One-shot job for the local model: `{ task, files?, max_words? }`. The server reads the files itself (only inside the chat's folders, size caps, no secret-looking files), so their text never passes through Claude; Claude gets only the short answer. Main chat only, cloud chats only. | `server/delegate.ts` |
| Worker pick | The router model that is loaded (or sleeping, or loading); else the first router model in `PHOSPHOR_LOCAL_MODELS`. Never a model on its own server (Strata), never a swap away from one that holds the GPU (BUSY while a Strata model loads or answers through the relay; its requests carry `x-phosphor-no-swap`, so the relay answers 409 instead of making room), never a load while the image engine is up. Down or busy: a tool error that tells Claude to do the job itself. | `server/delegate.ts` |
| Queue | One local job at a time, 3 may wait, a wait limit and one time limit for the whole call (its wait included); STOP cancels. The request goes through the local relay, so it takes its GPU turn and shows in SYS like any local request. | `server/delegate.ts` |
| Thread workers | `start_thread` takes `worker`: `local`, `haiku`, `sonnet`, `opus` (default: the lead's model). A local thread is a full Claude Code agent on the local model (the existing local-tab path). The tool text says when each fits. | `server/delegate.ts`, `Tab.projectTools`, `Tabs.thread` |
| Guidance | A short text appended to the system prompt of cloud chats when a local model is set up: when handing off pays, when not, and that Claude checks what comes back. | `server/delegate.ts` |
| Ledger | Per chat and in total: jobs, failures, tokens the local model read and wrote, and the estimated Claude tokens kept off (below). `data/router.json`. | `server/delegate.ts` |
| ROUTER card | Mission panel: this chat's and all chats' numbers, the worker, and a lead's thread workers. `GET /api/router` for the totals. | `web/src/routercard.ts` |

## Honest counting

"Kept off Claude" counts only file text the server read for the local model, which Claude never saw:

- about 4 characters per token (an estimate; marked `~`), minus the answer Claude reads back;
- each file once per chat (a second job on the same file saves nothing new);
- taken back when Claude reads that file itself later with Read (it saw it after all);
- jobs with no files count 0 (Claude wrote the task text either way); failed jobs count 0.

It is an upper bound of what reading the files would have cost: Claude might have read only a part (grep, tail). The local model's own token counts (in and out) are shown separately as the work it did.

## AUTO and LOCAL (checked, not built)

A chat runs one Claude Code process. Claude and a local model are different servers (base URL, model names in the process's environment), so switching a running chat between them restarts the process and resumes the session (`Tab.setModel`). For one simple message that costs:

- the local model reads the whole chat first: Claude Code's own prompt alone is 16-22K tokens, plus the chat so far; on this card that is tens of seconds before the first word, more than a Haiku answer takes in total;
- the way back: local thinking blocks carry empty signatures; whether the Claude API takes the chat back after them is the open risk in `docs/LOCAL-MODEL.md` (not tried here: the night's tests kept to one cloud chat);
- Claude's prompt cache is cold again when the local detour outlasts its life, so the next Claude turn re-reads the chat.

A simple message on Haiku costs few tokens anyway. So AUTO keeps its three cloud picks; the saving comes from jobs handed off inside the chat (`ask_local`) and from local threads, where the chat that runs locally stays local. A tab the owner sets to a local model by hand keeps working as before.

## Measured (2026-10-25, Qwen3.6 35B MoE on a 20 GB AMD card, through the relay)

| Job | File | Local tokens in / out | Time | Result |
|---|---|---|---|---|
| Incidents in a log | 112K characters, 1,855 lines | 69,458 / 340 | 43 s (37 s reading at about 1,900 tokens/s) | all 5 incidents and times right; the count of 502 lines wrong (31 or 33, really 43) |
| Same, thinking at low | same | 69,482 / 1,936 | 69 s | no answer: every token went to thinking |
| Decisions in meeting notes | 66K characters | about 16K / small | 12 s | all 4 decisions, actions and questions right |
| Themes in a CSV | 85K characters, 1,500 rows | about 21K / small | 20 s | the 4 themes right, every count wrong |

So: no thinking for jobs, room for files at 1.6 characters a token (logs are dense), and the guidance says exact counts and math are not local jobs. One cloud chat (Sonnet, low effort, "summarize these three files", no hint about the tool): Claude checked the sizes, handed all three files to `ask_local`, tried a `grep` spot-check (refused by the test script) and said it had not verified them. Its turn: 4 API calls, 31,854 cache-write and 86,856 cache-read tokens, 1,649 out; context after it 32K. Reading the files itself would have added about 66K tokens (4 characters a token; the local model counted 125K for the same text) to the cache once, and to every later request of the chat.

## In v1

- `ask_local` with file reading, folder checks, caps, queue, timeouts, worker pick, GPU and Strata safety, STOP.
- `start_thread` `worker` choice.
- System prompt guidance for cloud chats (off: `PHOSPHOR_ROUTER=off`).
- Ledger in `data/router.json`, ROUTER card, `GET /api/router`, demo data.
- Tests with fakes (`tests/delegate.ts`), a few real local jobs, one real cloud chat (numbers in the night report).

## Later

- A cheap cloud worker (OpenRouter or similar) for `ask_local`-style jobs: a second `Worker` in `server/delegate.ts` (same `run` shape: prompt in, text and token counts out), its key in `.env`, picked when the local model is down or busy, or by name (`worker` argument). No account or key is added now.
- Cloud threads on a non-Claude model: needs an agent runtime that speaks to that provider (`docs/AGENTS-PLAN.md`).
- Count local threads' tokens in the ledger (the tab sees the local model's usage on each reply).
- Let ask_local use a model on its own server (Strata) when it is the one already loaded and idle.
- Images in jobs (the local models see pictures): screenshots to describe without sending them to Claude.
