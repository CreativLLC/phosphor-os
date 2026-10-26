# KEYWORDS: YouTube keyword check

Check YouTube search terms before you title a video: how much people look for each term, how hard it is to show up for it, and which longer searches and tags go with it. Like the keyword search in vidIQ or TubeBuddy, with no account and no API key.

## Use it

- **Screen:** KEYWORDS (program bar, header or phone MENU). Type up to 10 terms, CHECK, wait about 8 s per term. Tap a row for the reasons, the top videos, related searches and tags. SUGGEST gives autocomplete ideas for a seed word. HISTORY keeps every run.
- **Command line (and Claude):** `npx tsx scripts/keywords.ts "term one" "term two" [--region US] [--json]`, or `--suggest "seed"`. Runs from the command line are saved the same way and show on the screen.

## Where the numbers come from

YouTube does not publish how many people search a term. Every keyword tool estimates it. This one uses, per term:

| Signal | Source | Feeds |
|---|---|---|
| How early autocomplete offers the term (letters typed before it shows up) | YouTube autocomplete (suggestqueries, ds=yt) | demand |
| Longer searches that build on the term | YouTube autocomplete | demand, related |
| Views a day of the top videos from the last 2 years | YouTube search page + yt-dlp | demand |
| Interest next to the other terms in the run (0-100) | Google Trends, YouTube search, last 12 months | demand (when Trends answers) |
| Channel sizes of the top 10 videos | yt-dlp | competition |
| Share of the top 10 with every word of the term in the title | YouTube search page | competition |
| Views of the top 10 | YouTube search page + yt-dlp | competition |
| "About N results" | YouTube search page | competition |
| Small channels (under 50K subscribers) in the top 10 with more views than subscribers | yt-dlp | lowers competition |

- **Score** = demand × (1 − 0.75 × competition / 100). **Verdict:** great 55+, good 42+, ok 30+, else hard; demand under 25 is "low demand" whatever the score.
- Weights live in `scoreTerm` (server/keywords.ts). Trends compares only the terms inside one run (more than 5 terms: batches scaled to the first term), so it never compares across runs.

## Files

| What | Where |
|---|---|
| Engine, run store, HTTP | `server/keywords.ts` (routes in `shared/keywords.ts`) |
| Command line | `scripts/keywords.ts` |
| Screen | `web/src/keywords.ts`, `web/src/keywords.css`, demo data `web/src/keywordsdemo.ts` |
| Runs | `data/keywords/<id>.json`; cache per term and region `data/keywords/.cache/` (24 h) |
| Tests | `npx tsx tests/keywords.ts` (no network) |

## Notes

- Terms run one after another with short pauses, to be polite to YouTube; a run of 10 takes about a minute and a half. A cached term is instant.
- A run whose process died stays "running" on disk; after 15 minutes untouched it reads as failed.
- If YouTube changes its search page, `parseSearch` throws "YouTube search page changed" for each term; fix the parser. If yt-dlp is missing, subscriber counts are unknown and competition leans on the other signals. Trends often answers 429; the run still finishes without it.
