export type DictateSettings = { icon: boolean; cleanup: boolean; screen?: string; x?: number; y?: number; [key: string]: unknown };
export type ActiveWindow = { class?: string; initialClass?: string; tags?: string[] } | null | undefined;
export type CleanUpResult = { text: string; cleaned: boolean; by: string; error: string };

export const SETTINGS_DEFAULTS: { icon: boolean; cleanup: boolean };
export function settingsFile(home: string): string;
export function readSettings(text: string): DictateSettings;
export function isTerminal(win: ActiveWindow): boolean;
export function pasteKeys(platform: string, win: ActiveWindow): { mods: string; key: string };
export function pasteWords(platform: string, win: ActiveWindow, text: string): string;
export function joinPhrase(text: string, raw: string, joinPrev?: boolean): string;
export function finalText(text: string): string;
export const CLEANUP_TIMEOUT_MS: number;
export function cleanUp(
  text: string,
  opts?: { url?: string; headers?: Record<string, string>; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<CleanUpResult>;
