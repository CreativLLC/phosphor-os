export const MAX_CANDIDATES: number;
export type PathFound = { raw: string; line: number; col: number };
export function extOf(path: string, platform: string): string;
export function canOpen(path: string, isDir: boolean, mode: number | undefined, platform: string): boolean;
export function scanPaths(text: string, platform: string): (PathFound & { start: number; end: number })[];
export function inlineCodePath(text: string, platform: string): PathFound | null;
export function linkTargetPath(href: string, platform: string): PathFound | null;
export function fileUrlPath(url: string, platform: string): string | null;
