// STATION (homelab hub): shapes shared by server/station.ts and web/src/station.ts.
// The services list is the owner's (data/station.json); nothing here names their servers.

// App kinds the owner can pick for a service. `skin` is the look the desktop app puts on that app's pages
// (shell/skins.mjs); kinds without one get the careful generic skin.
export const STATION_KINDS = [
  { id: 'generic', label: 'OTHER' },
  { id: 'nextcloud', label: 'NEXTCLOUD' },
  { id: 'nextcloud-aio', label: 'NEXTCLOUD AIO' },
  { id: 'immich', label: 'IMMICH' },
  { id: 'plex', label: 'PLEX' },
  { id: 'jellyfin', label: 'JELLYFIN' },
  { id: 'sonarr', label: 'SONARR' },
  { id: 'radarr', label: 'RADARR' },
  { id: 'prowlarr', label: 'PROWLARR' },
  { id: 'lidarr', label: 'LIDARR' },
  { id: 'readarr', label: 'READARR' },
  { id: 'sabnzbd', label: 'SABNZBD' },
  { id: 'qbittorrent', label: 'QBITTORRENT' },
  { id: 'unraid', label: 'UNRAID' },
  { id: 'home-assistant', label: 'HOME ASSISTANT' },
  { id: 'portainer', label: 'PORTAINER' },
  { id: 'uptime-kuma', label: 'UPTIME KUMA' },
  { id: 'vaultwarden', label: 'VAULTWARDEN' },
  { id: 'paperless', label: 'PAPERLESS' },
  { id: 'audiobookshelf', label: 'AUDIOBOOKSHELF' },
  { id: 'calibre', label: 'CALIBRE' },
  { id: 'proxy-manager', label: 'PROXY MANAGER' },
] as const;

export type StationKind = (typeof STATION_KINDS)[number]['id'];

export const isStationKind = (v: unknown): v is StationKind => STATION_KINDS.some((k) => k.id === v);

export const kindLabel = (id: string): string => STATION_KINDS.find((k) => k.id === id)?.label ?? 'OTHER';

// selfSigned: the health check accepts a certificate this PC does not trust (your own server's). Checks only.
// skin: the desktop app shows this app's pages in the Retro look.
export type StationService = { id: string; name: string; url: string; kind: StationKind; selfSigned: boolean; skin: boolean };

export type StationState = 'up' | 'slow' | 'down' | 'unknown';

export type StationCheck = { at: number; state: StationState; ms: number | null };

export type StationStatus = {
  state: StationState;
  ms: number | null; // response time of the last check
  code: number | null; // HTTP status of the last check
  at: number; // when it was last checked (0 = never)
  lastUp: number | null; // last time it answered
  note: string; // why it is down or slow, in plain words
  history: StationCheck[]; // oldest first
};

// The last 24 hours of checks in 96 cells of 15 minutes (server/stationhealth.ts). cells, oldest first, newest last:
// u all up, s some slow, p some down and some up, d all down, . no check in that time.
export type StationDay = {
  cells: string;
  checks: number; // checks counted in the 24 hours
  upPct: number | null; // share of them that answered (SLOW counts as answered); null: no checks
  avgMs: number | null; // average answer time of the answered ones
};

export type StationEntry = StationService & { status: StationStatus; day: StationDay };

export type StationResponse = {
  services: StationEntry[];
  checking: boolean; // a check round runs now: ask again soon
  everyMs: number; // checks repeat this often while STATION is on screen
  slowMs: number; // answers slower than this are SLOW
  error?: string;
};

// POST /api/station/save: id missing = add.
export type StationSaveRequest = { id?: string; name: string; url: string; kind: string; selfSigned: boolean; skin: boolean };

// DISCOVER: one open port that answered on the host.
export type StationFound = {
  port: number;
  url: string; // where to open it
  app: string; // best guess, plain name ("Sonarr")
  kind: StationKind;
  sure: boolean; // the guess came from the page (title, headers), not just the port number
  title: string; // page title, if any
  code: number | null; // HTTP status, null = the port is open but it does not speak HTTP
  ms: number;
  selfSigned: boolean;
};

export type StationDiscoverResponse = {
  host: string;
  addresses: string[];
  results: StationFound[];
  scanned: number; // ports tried
  ms: number;
  error?: string;
};
