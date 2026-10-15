export function adoptOldEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function envFileValue(text: string, key: string): string;
export function appFolder(parent: string, pathJoin?: (...parts: string[]) => string, exists?: (path: string) => boolean): string;
