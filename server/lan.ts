import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { connect, isIP, type LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { StationFound, StationKind } from '../shared/station.ts';

// STATION's network side (server/station.ts): which hosts DISCOVER may look at, small HTTP probes and app guesses.
// No app config here, so tests can import it on its own.
//
// DISCOVER only ever touches the owner's own network: loopback, RFC 1918, link-local, the tailnet (100.64.0.0/10,
// *.ts.net) and IPv6 unique-local. A name must resolve ONLY to such addresses, and the probes then connect to the
// address that was checked (no second DNS answer can swap in a public one).

// ---------------------------------------------------------------- addresses

type Range = { base: number; bits: number; label: string };
const V4: Range[] = [
  ['127.0.0.0', 8, 'localhost'],
  ['10.0.0.0', 8, 'private'],
  ['172.16.0.0', 12, 'private'],
  ['192.168.0.0', 16, 'private'],
  ['169.254.0.0', 16, 'link-local'],
  ['100.64.0.0', 10, 'tailnet'],
].map(([b, bits, label]) => ({ base: v4Int(b as string)!, bits: bits as number, label: label as string }));

function v4Int(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
}

// "fe80::1%eth0" -> 8 numbers, or null.
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/); // ::ffff:192.168.0.1
  if (tail) {
    const n = v4Int(tail[1]);
    if (n === null) return null;
    s = s.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(':') : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if ((halves.length === 2 && fill < 1) || (halves.length === 1 && fill !== 0)) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

// What kind of own-network address this is, or null for anything else (public, multicast, 0.0.0.0, junk).
export function lanKind(ip: string): string | null {
  const fam = isIP(ip.replace(/%.*$/, ''));
  if (fam === 4) {
    const n = v4Int(ip)!;
    const r = V4.find((x) => Math.floor(n / 2 ** (32 - x.bits)) === Math.floor(x.base / 2 ** (32 - x.bits)));
    return r?.label ?? null;
  }
  if (fam !== 6) return null;
  const g = v6Groups(ip);
  if (!g) return null;
  // IPv4-mapped (::ffff:a.b.c.d): judge the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return lanKind(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'localhost';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if (g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0) return 'tailnet'; // Tailscale's IPv6 range
  if ((g[0] & 0xfe00) === 0xfc00) return 'private'; // unique local, IPv6's RFC 1918
  return null;
}

// What the owner typed ("192.168.0.10", "nas.local", "http://box:8080/x", "[fe80::1]") -> a bare host name or IP.
export function hostFromInput(text: string): string | null {
  let s = String(text ?? '').trim();
  if (!s || s.length > 300) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  } else {
    s = s.replace(/[/?#].*$/, '');
    if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined);
    else if ((s.match(/:/g) ?? []).length === 1) s = s.replace(/:\d*$/, ''); // host:port
  }
  s = s.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(s.replace(/%.*$/, ''))) return s;
  if (s.length > 253 || !s.split('.').every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  return s;
}

export type LanHost = { host: string; addresses: string[] } | { error: string };

type Resolver = (host: string) => Promise<string[]>;
const systemResolve: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

// The one gate for DISCOVER. Every address the name has must be on the owner's network.
export async function resolveLanHost(text: string, resolve: Resolver = systemResolve): Promise<LanHost> {
  const host = hostFromInput(text);
  if (!host) return { error: 'Type a host: a LAN address like 192.168.1.10, a name like nas.local, or a tailnet name.' };
  if (isIP(host.replace(/%.*$/, ''))) {
    return lanKind(host) ? { host, addresses: [host] } : { error: `${host} is not on your own network. DISCOVER only looks at home, LAN and tailnet addresses.` };
  }
  let addresses: string[];
  try {
    addresses = [...new Set(await resolve(host))];
  } catch {
    return { error: `Could not find "${host}" on the network.` };
  }
  if (!addresses.length) return { error: `Could not find "${host}" on the network.` };
  const outside = addresses.filter((a) => !lanKind(a));
  if (outside.length) return { error: `${host} points to an address outside your network (${outside[0]}). DISCOVER only looks at home, LAN and tailnet addresses.` };
  // IPv4 first: home servers often answer only there.
  addresses.sort((a, b) => isIP(a) - isIP(b));
  return { host, addresses };
}

// ---------------------------------------------------------------- probes

// The TCP port accepts a connection (nothing is sent).
export function tcpOpen(address: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: address, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export type ProbeOptions = {
  timeoutMs: number; // whole probe, redirects included
  insecure?: boolean; // accept a certificate this PC does not trust
  readBody?: number; // bytes of the page to read (for the title); 0 = stop at the headers
  hops?: number; // same-host redirects to follow
  address?: string; // connect here instead of asking DNS again (DISCOVER)
};

export type ProbeResult = {
  code: number | null; // null: no HTTP answer
  ms: number;
  headers: IncomingHttpHeaders;
  body: string;
  url: string; // the last address asked
  offHost: string; // a redirect to another host, not followed
  error: string; // plain words, '' when it answered
  errorCode: string;
  selfSigned: boolean; // answered over HTTPS with a certificate this PC does not trust
};

const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS_CERT_ALTNAME_INVALID/;

function pinned(address: string): LookupFunction {
  const family = isIP(address);
  return ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    if (opts?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as LookupFunction;
}

// One GET. Redirects to the same host name are followed (up to `hops`); a redirect to another host is never
// followed: it is reported in offHost. The body is read only up to `readBody` bytes, then the socket closes.
export async function probe(start: string, o: ProbeOptions): Promise<ProbeResult> {
  const t0 = Date.now();
  const deadline = t0 + o.timeoutMs;
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    return fail(start, t0, 'Not a web address.', 'BAD_URL');
  }
  const startHost = url.hostname.toLowerCase();
  for (let hop = 0; ; hop++) {
    if (!/^https?:$/.test(url.protocol)) return fail(url.href, t0, 'Only http and https addresses can be checked.', 'BAD_URL');
    const r = await once(url, o, deadline);
    r.ms = Date.now() - t0;
    const loc = r.headers.location;
    if (r.code === null || r.code < 300 || r.code > 399 || !loc) return r;
    let next: URL;
    try {
      next = new URL(Array.isArray(loc) ? loc[0] : loc, url);
    } catch {
      return r;
    }
    if (!/^https?:$/.test(next.protocol)) return r;
    if (next.hostname.toLowerCase() !== startHost) return { ...r, offHost: next.host };
    if (hop >= (o.hops ?? 0) || Date.now() >= deadline) return r;
    url = next;
  }
}

function fail(url: string, t0: number, error: string, errorCode: string): ProbeResult {
  return { code: null, ms: Date.now() - t0, headers: {}, body: '', url, offHost: '', error, errorCode, selfSigned: false };
}

function once(url: URL, o: ProbeOptions, deadline: number): Promise<ProbeResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const left = deadline - Date.now();
    if (left <= 0) return resolve(fail(url.href, t0, `No answer in ${Math.round(o.timeoutMs / 1000)} s.`, 'TIMEOUT'));
    let settled = false;
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const mod = url.protocol === 'https:' ? https : http;
    const name = url.hostname.replace(/^\[|\]$/g, '');
    const req = mod.request(
      url,
      {
        method: 'GET',
        agent: false,
        headers: { 'User-Agent': 'PhosphorOS-Station/1', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', Connection: 'close' },
        rejectUnauthorized: !o.insecure,
        ...(o.address ? { lookup: pinned(o.address) } : {}),
        ...(url.protocol === 'https:' && !isIP(name) ? { servername: name } : {}),
      },
      (res) => {
        const selfSigned = url.protocol === 'https:' && (res.socket as TLSSocket).authorized === false;
        const base = { code: res.statusCode ?? null, ms: 0, headers: res.headers, body: '', url: url.href, offHost: '', error: '', errorCode: '', selfSigned };
        const want = o.readBody ?? 0;
        const type = String(res.headers['content-type'] ?? '');
        if (!want || (type && !/html|xml|text|json/i.test(type))) {
          res.destroy();
          return finish(base);
        }
        const chunks: Buffer[] = [];
        let got = 0;
        const end = () => {
          res.destroy();
          finish({ ...base, body: Buffer.concat(chunks).toString('utf8') });
        };
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          got += c.length;
          if (got >= want) end();
        });
        res.on('end', end);
        res.on('error', end);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(fail(url.href, t0, `No answer in ${Math.round(o.timeoutMs / 1000)} s.`, 'TIMEOUT'));
    }, left);
    req.on('error', (e: NodeJS.ErrnoException) => finish(fail(url.href, t0, errorText(e), e.code ?? 'ERROR')));
    req.end();
  });
}

function errorText(e: NodeJS.ErrnoException): string {
  const code = e.code ?? '';
  if (CERT_CODES.test(code)) return 'Its certificate is not trusted by this PC. If it is your own server, turn on SELF-SIGNED.';
  if (code === 'ECONNREFUSED') return 'Nothing answers on that port (connection refused).';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'That name was not found.';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'That host cannot be reached from this PC.';
  if (code === 'ECONNRESET') return 'The connection was cut.';
  if (code === 'EPROTO' || /wrong version number|packet length too long/i.test(e.message)) return 'It does not speak HTTPS on that port.';
  return e.message || code || 'Failed.';
}

export function titleOf(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return m[1]
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' })[n as 'amp'] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ---------------------------------------------------------------- what app is it?

type Sign = { app: string; kind: StationKind; test: (title: string, body: string, h: IncomingHttpHeaders) => boolean };
const t = (re: RegExp, app: string, kind: StationKind = 'generic'): Sign => ({ app, kind, test: (title) => re.test(title) });

// Most specific first.
const SIGNS: Sign[] = [
  { app: 'Nextcloud AIO', kind: 'nextcloud-aio', test: (title, body) => /^AIO$/i.test(title) && /nextcloud/i.test(body) },
  { app: 'Nextcloud', kind: 'nextcloud', test: (title, body) => /nextcloud/i.test(title) || (/id="body-(login|user|public)"/.test(body) && /nextcloud/i.test(body)) },
  t(/immich/i, 'Immich', 'immich'),
  { app: 'Plex', kind: 'plex', test: (title, _b, h) => /^plex$/i.test(title) || h['x-plex-protocol'] !== undefined },
  t(/jellyfin/i, 'Jellyfin', 'jellyfin'),
  t(/\bemby\b/i, 'Emby'),
  t(/sonarr/i, 'Sonarr', 'sonarr'),
  t(/radarr/i, 'Radarr', 'radarr'),
  t(/prowlarr/i, 'Prowlarr', 'prowlarr'),
  t(/lidarr/i, 'Lidarr', 'lidarr'),
  t(/readarr/i, 'Readarr', 'readarr'),
  t(/bazarr/i, 'Bazarr'),
  t(/whisparr/i, 'Whisparr'),
  { app: 'SABnzbd', kind: 'sabnzbd', test: (title, body) => /sabnzbd/i.test(title) || /id="sabnzbd"/.test(body) },
  t(/nzbget/i, 'NZBGet'),
  t(/qbittorrent/i, 'qBittorrent', 'qbittorrent'),
  t(/transmission/i, 'Transmission'),
  t(/deluge/i, 'Deluge'),
  { app: 'Unraid', kind: 'unraid', test: (title, body) => /unraid/i.test(title) || (/\/(login|dashboard|main)$/i.test(title) && /\/webGui\//.test(body)) },
  t(/home assistant/i, 'Home Assistant', 'home-assistant'),
  t(/portainer/i, 'Portainer', 'portainer'),
  t(/uptime kuma/i, 'Uptime Kuma', 'uptime-kuma'),
  t(/vaultwarden|bitwarden/i, 'Vaultwarden', 'vaultwarden'),
  t(/paperless/i, 'Paperless', 'paperless'),
  t(/audiobookshelf/i, 'Audiobookshelf', 'audiobookshelf'),
  t(/calibre-web/i, 'Calibre-Web', 'calibre'),
  { app: 'Calibre', kind: 'calibre', test: (title, _b, h) => /^calibre/i.test(title) || /realm="calibre"/i.test(String(h['www-authenticate'] ?? '')) },
  t(/nginx proxy manager/i, 'Nginx Proxy Manager', 'proxy-manager'),
  t(/overseerr/i, 'Overseerr'),
  t(/jellyseerr/i, 'Jellyseerr'),
  t(/tautulli/i, 'Tautulli'),
  t(/grafana/i, 'Grafana'),
  t(/adguard/i, 'AdGuard Home'),
  t(/pi-hole/i, 'Pi-hole'),
  t(/syncthing/i, 'Syncthing'),
  t(/navidrome/i, 'Navidrome'),
  t(/photoprism/i, 'PhotoPrism'),
  t(/netdata/i, 'Netdata'),
  t(/homarr/i, 'Homarr'),
  t(/dozzle/i, 'Dozzle'),
  t(/gitea/i, 'Gitea'),
  t(/forgejo/i, 'Forgejo'),
  t(/code-server|vs ?code/i, 'code-server'),
  t(/frigate/i, 'Frigate'),
  t(/kavita/i, 'Kavita'),
  t(/komga/i, 'Komga'),
  t(/mealie/i, 'Mealie'),
];

export function guessApp(title: string, body: string, headers: IncomingHttpHeaders): { app: string; kind: StationKind } | null {
  const s = SIGNS.find((x) => x.test(title, body, headers));
  return s ? { app: s.app, kind: s.kind } : null;
}

// Common self-hosted ports. app/kind: the usual tenant, used only when the page itself gives no clue.
// tls: try HTTPS first. path: where its web page lives.
export type PortHint = { port: number; app: string; kind?: StationKind; tls?: boolean; path?: string };
export const DISCOVER_PORTS: PortHint[] = [
  { port: 80, app: 'Web server' },
  { port: 443, app: 'Web server', tls: true },
  { port: 81, app: 'Nginx Proxy Manager', kind: 'proxy-manager' },
  { port: 2283, app: 'Immich', kind: 'immich' },
  { port: 32400, app: 'Plex', kind: 'plex', path: '/web' },
  { port: 8096, app: 'Jellyfin', kind: 'jellyfin' },
  { port: 8920, app: 'Jellyfin', kind: 'jellyfin', tls: true },
  { port: 8989, app: 'Sonarr', kind: 'sonarr' },
  { port: 7878, app: 'Radarr', kind: 'radarr' },
  { port: 9696, app: 'Prowlarr', kind: 'prowlarr' },
  { port: 8686, app: 'Lidarr', kind: 'lidarr' },
  { port: 8787, app: 'Readarr', kind: 'readarr' },
  { port: 6767, app: 'Bazarr' },
  { port: 8080, app: 'qBittorrent or SABnzbd' },
  { port: 8090, app: 'qBittorrent', kind: 'qbittorrent' },
  { port: 6789, app: 'NZBGet' },
  { port: 9091, app: 'Transmission' },
  { port: 8112, app: 'Deluge' },
  { port: 7282, app: 'Nextcloud AIO', kind: 'nextcloud-aio', tls: true },
  { port: 8443, app: 'Nextcloud AIO', kind: 'nextcloud-aio', tls: true },
  { port: 11000, app: 'Nextcloud', kind: 'nextcloud' },
  { port: 8088, app: 'Web server' },
  { port: 8008, app: 'Web server' },
  { port: 8123, app: 'Home Assistant', kind: 'home-assistant' },
  { port: 9443, app: 'Portainer', kind: 'portainer', tls: true },
  { port: 9000, app: 'Portainer', kind: 'portainer' },
  { port: 3001, app: 'Uptime Kuma', kind: 'uptime-kuma' },
  { port: 8000, app: 'Paperless or Vaultwarden' },
  { port: 8081, app: 'Web app' },
  { port: 8083, app: 'Calibre-Web', kind: 'calibre' },
  { port: 13378, app: 'Audiobookshelf', kind: 'audiobookshelf' },
  { port: 5055, app: 'Overseerr or Jellyseerr' },
  { port: 8181, app: 'Tautulli' },
  { port: 3000, app: 'Web app' },
  { port: 8384, app: 'Syncthing' },
  { port: 4533, app: 'Navidrome' },
  { port: 2342, app: 'PhotoPrism' },
  { port: 19999, app: 'Netdata' },
  { port: 5000, app: 'Web app' },
  { port: 8200, app: 'Web app' },
];

// ---------------------------------------------------------------- DISCOVER

export type DiscoverOptions = { ports?: PortHint[]; concurrency?: number; connectMs?: number; httpMs?: number };

// Looks at one host that already passed resolveLanHost. Gentle: a few ports at a time, short timeouts, one
// page read per open port (two when the first way in is the wrong one: http vs https).
export async function discoverHost(host: string, address: string, o: DiscoverOptions = {}): Promise<StationFound[]> {
  const ports = o.ports ?? DISCOVER_PORTS;
  const found: StationFound[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ports.length) {
      const hint = ports[next++];
      const f = await probePort(host, address, hint, o);
      if (f) found.push(f);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 6, ports.length) }, worker));
  return found.sort((a, b) => a.port - b.port);
}

async function probePort(host: string, address: string, hint: PortHint, o: DiscoverOptions): Promise<StationFound | null> {
  if (!(await tcpOpen(address, hint.port, o.connectMs ?? 1000))) return null;
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  const schemes = hint.tls ? ['https', 'http'] : ['http', 'https'];
  for (const scheme of schemes) {
    const base = `${scheme}://${urlHost}:${hint.port}`;
    const r = await probe(`${base}/`, { timeoutMs: o.httpMs ?? 2500, insecure: true, readBody: 64 * 1024, hops: 3, address });
    if (r.code === null) continue;
    const page = titleOf(r.body);
    if (r.code === 400 && /plain http request was sent to https/i.test(`${page} ${r.body}`)) continue;
    const title = page || (r.offHost ? `Goes on to ${r.offHost}` : '');
    const g = guessApp(page, r.body, r.headers);
    const app = g?.app ?? (page && !/^(\d{3}\b|redirecting|default site|index of|directory listing)/i.test(page) ? page.slice(0, 40) : `${hint.app}?`);
    const kind = g?.kind ?? hint.kind ?? 'generic';
    const path = kind === 'plex' ? '/web' : (hint.path ?? '/');
    const shortBase = (scheme === 'http' && hint.port === 80) || (scheme === 'https' && hint.port === 443) ? `${scheme}://${urlHost}` : base;
    return { port: hint.port, url: shortBase + path, app, kind, sure: !!g, title, code: r.code, ms: r.ms, selfSigned: r.selfSigned };
  }
  return null;
}
