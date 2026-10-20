// The desktop app's bridge (shell/preload.cjs + shell/web.mjs). Missing in a normal browser and on the phone.

export type Site = { id: string; name: string; url: string };

// A real program on this PC (Firefox, the Discord app). Its path stays in the desktop app; the page sees the name.
export type App = { id: string; name: string };

// owner: 'web' (a WEB browser tab) or the id of the saved site the tab belongs to.
export type WebTab = { id: string; owner: string; title: string; url: string; loading: boolean; canBack: boolean; canForward: boolean; audible: boolean };

export type WebState = { apps: App[]; sites: Site[]; tabs: WebTab[] };

export type Rect = { x: number; y: number; width: number; height: number };

export type WebAction = 'back' | 'forward' | 'reload' | 'stop' | 'close' | 'outside' | 'home';

// Launcher lists (shell/installed.mjs). id: a hash the shell looks up in its own scan. icon: small data URL.
export type InstalledApp = { id: string; name: string; hint?: string; words?: string; icon?: string };
export type Game = { id: string; name: string; hint?: string }; // id = Steam appid

// STATION skins (shell/skins.mjs): the app's theme and which addresses get which app's skin.
export type SkinConfig = { theme: string; crt: string; sites: { origin: string; kind: string }[] };

// Commands from keys pressed while a site has the keyboard: 'program:N' (Ctrl+1..9), 'focus-address' (Ctrl+L).
// (A site's link to a new tab opens in the normal browser.)
export type PhosphorShell = {
  version: 1;
  // The desktop app's OS ('linux', 'win32', 'darwin'). Optional: an older desktop app does not have it.
  platform?: string;
  state(): Promise<WebState | null>;
  newTab(url?: string): Promise<string | null>; // a new WEB tab; '' = blank
  site(id: string): Promise<string | null>; // the tab of a saved site (made on first use)
  show(tab: string | null, rect: Rect | null, focus?: boolean): void; // null = hide all sites
  navigate(tab: string, input: string): void; // address, bare domain or search words
  act(tab: string, action: WebAction): void; // 'home' = back to a saved site's own address
  setSites(sites: Site[]): void; // the program bar's saved sites, in order
  launch(id: string): Promise<'front' | 'started' | 'failed'>; // bring the app to the front, or start it
  setApps(apps: App[]): void; // rename, reorder or remove app buttons (it cannot add one)
  onChange(fn: (s: WebState) => void): void;
  onCommand(fn: (c: string) => void): void;
  // Launcher. Optional: an older desktop app does not have them.
  installed?(): Promise<InstalledApp[] | null>;
  games?(): Promise<Game[] | null>;
  openInstalled?(id: string): Promise<boolean>;
  openGame?(id: string): Promise<boolean>;
  // STATION skins. Optional: an older desktop app does not have it.
  setSkins?(cfg: SkinConfig): void;
  // The clipboard's picture as PNG bytes, or null. Optional: an older desktop app does not have it.
  clipboardImage?(): Promise<Uint8Array | null>;
  // Show a file (or open a folder) in the system file manager. Optional: an older desktop app does not have it.
  showInFolder?(path: string): Promise<boolean>;
  // Open a picture file in the system image viewer. Optional: an older desktop app does not have it.
  openImage?(path: string): Promise<boolean>;
};

declare global {
  interface Window {
    phosphorShell?: PhosphorShell;
  }
}

export const shellApi: PhosphorShell | undefined = window.phosphorShell;
