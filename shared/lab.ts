// Model Lab (docs/MODEL-LAB.md): what the server and the LAB screens send each other. The files on disk
// (test.json, result.json) hold the same fields plus `schema`.

export type LabApp = 'claude' | 'codex' | 'opencode' | 'agy' | 'local';
export type LabState = 'queued' | 'running' | 'done' | 'failed' | 'limit' | 'stopped';

export const LAB_TIME_LIMITS = [5, 10, 30, 60, 120];

// How hard the models think, one setting for the whole test. Each app takes it in its own words, and a model that
// lacks the asked level gets the nearest one it has (server/labrun.ts nearestEffort). 'default' = the app decides.
export type LabEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const LAB_EFFORTS: LabEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
export const LAB_MAX_MODELS = 12; // in one test, + MODELS included
export const LAB_LETTERS = 'ABCDEFGHIJKLMNOP'; // blind mode names the results MODEL A, B, ... in the order of the test's results
export const LAB_FOLLOW_UP_MAX = 20_000; // characters in one follow-up

export interface LabModel {
  id: string; // "<app>:<model id in that app>", e.g. "opencode:opencode-go/kimi-k3.1-pro"
  name: string;
  app: LabApp;
  appName: string;
  account: string;
  efforts: string[]; // the effort levels it takes, lowest first ([] = none: it always runs at its default)
}

export interface LabModelsResponse {
  models: LabModel[];
  notes: string[]; // apps that are missing or not signed in, in plain words
}

export interface LabResult {
  dir: string; // its folder inside the test folder
  model: string; // LabModel id
  modelName: string;
  app: LabApp;
  appName: string;
  appVersion: string;
  account: string;
  state: LabState;
  startedAt: number; // 0 while queued
  endedAt: number;
  tokens: number;
  value: number | null; // what the run would have cost at API prices, when the app says
  stars: number; // 0 = not rated
  rank: number; // place in the owner's best-to-worst order: 1 = best, 0 = not ranked
  timeUp: boolean; // the time limit stopped it; it counts as done and is judged on what it had made by then
  effort: string; // the level it ran at ('default' = the app chose), '' before it started
  note: string;
  error: string;
  followUps: LabFollowUp[]; // the owner's follow-ups since its last run from scratch, oldest first
}

// FOLLOW UP: more words for a result's model once it has finished. It works on in the same files folder; what the
// result had just before is kept as a version (versions/<version>/ in the result folder, server/labfollow.ts).
export interface LabFollowUp {
  text: string;
  at: number;
  version: number; // the version that holds the result as it was just before this follow-up
}

// A version of a result kept before a follow-up or RUN AGAIN: its result.json, reply and files as they were then.
export interface LabVersion extends LabResult {
  n: number; // versions/<n>/ in the result folder; the viewer shows its files at <view><result dir>@<n>/<path>
  reply: string;
  page: string; // a web page in its files, or ''
}

export interface LabFile {
  path: string; // inside files/
  bytes: number;
}

export interface LabResultFull extends LabResult {
  reply: string;
  files: LabFile[];
  page: string; // a web page it made, to show in a frame (path inside files/), or ''
  build: '' | 'building' | 'done' | 'failed'; // `npm run build` for a project that needs one (server/labrun.ts)
  canBuild: boolean; // it has a package.json with a build script
}

export interface LabTest {
  id: string; // the folder name: "<date>-<title words>"
  title: string;
  prompt: string;
  at: number;
  archived: boolean;
  blind: boolean;
  revealed: boolean;
  timeLimitMin: number;
  effort: LabEffort;
  results: LabResult[];
}

export interface LabTestFull extends Omit<LabTest, 'results'> {
  results: LabResultFull[];
  folder: string; // where it lives on the PC
  view: string; // URL the result files are served from: <view><result dir>/<path>
}

export interface LabNewTest {
  title?: string;
  prompt: string;
  models: string[];
  timeLimitMin: number;
  blind: boolean;
  effort?: LabEffort;
}

// A prompt used before, for the LIBRARY in NEW TEST: one per distinct prompt text.
export interface LabPrompt {
  title: string; // of the newest test that used it
  prompt: string;
  tests: number; // how many tests used exactly this text, archived ones too
  at: number; // when the newest one started
}

// The prompts of all tests (HISTORY and ARCHIVE), newest first, one entry per distinct text.
export function promptLibrary(tests: { title: string; prompt: string; at: number }[]): LabPrompt[] {
  const byText = new Map<string, LabPrompt>();
  for (const t of tests) {
    const text = t.prompt.trim();
    if (!text) continue;
    const p = byText.get(text);
    if (!p) byText.set(text, { title: t.title, prompt: text, tests: 1, at: t.at });
    else {
      p.tests++;
      if (t.at > p.at) [p.title, p.at] = [t.title, t.at];
    }
  }
  return [...byText.values()].sort((a, b) => b.at - a.at);
}

export interface LabStorage {
  tests: number;
  archived: number;
  bytes: number;
  junkBytes: number;
}
