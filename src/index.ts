interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}
/**
 * Iowa DMV MCP — the Iowa DOT Motor Vehicle Division's 18 driver license stations, with hours,
 * CDL testing, and the live queue cameras Iowa points at its own waiting rooms. Keyless.
 *
 * One pack per state agency: Iowa's motor-vehicle surface is a small, unusually rich station
 * layer — per-station queue-camera image URLs and a wait-time widget, which no other state
 * publishes — and nothing like California's ZIP-level registration snapshot. A union schema
 * across states would leave most arguments ignored, so Iowa gets its own tool.
 *
 * Source (verified live 2026-07-29):
 *   services.arcgis.com/8lRhdTsQyJpO52F1 DLSv2_View/FeatureServer/0 — 18 driver license
 *   stations with address, per-day hours, phone, CDL flag, station page, wait-time widget
 *   and up to four live camera image URLs.
 *
 * Two upstream quirks are handled here rather than passed through: the `state` column carries
 * the literal ", IA" with a leading comma, and the layer stores no latitude/longitude columns,
 * so coordinates come from WGS84 geometry.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-ia-dmv/1.0 (+https://pipeworx.io)';
const LAYER = 'https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/DLSv2_View/FeatureServer/0';

interface Station {
  state: string;
  name: string;
  office_type: string;
  address: string | null;
  city: string | null;
  county: string | null;
  zip: string | null;
  phone: string | null;
  fax: string | null;
  hours: string | null;
  latitude: number | null;
  longitude: number | null;
  services: string[];
  cdl_testing: boolean;
  queue_camera_urls: string[];
  wait_times_url: string | null;
  status_note: string | null;
  url: string | null;
}

async function loadStations(): Promise<Station[]> {
  // The layer has no lat/lng attribute columns, so ask for WGS84 geometry.
  const feats = await arcgisQuery(LAYER, { limit: 500, geometry: true, userAgent: UA });
  return feats.map((f) => {
    const a = f.attributes;
    const cdl = /^(y|yes|true)$/i.test(String(a.CDL ?? ''));
    return {
      state: 'IA', // The upstream `state` column reads ", IA" — a stray leading comma — so it is not passed through.
      name: [a.station_name, a.station_name2].filter(Boolean).join(' ').trim(),
      office_type: 'Driver license station',
      address: (a.address as string) ?? null,
      city: (a.city as string) ?? null,
      // Iowa's station layer carries no county column; the DOT keys these by city.
      county: null,
      zip: a.zip ? String(a.zip) : null,
      phone: (a.phone as string) ?? null,
      fax: (a.fax as string) ?? null,
      hours: govJoinHours([
        ['Mon', a.hours_mon], ['Tue', a.hours_tues], ['Wed', a.hours_wed],
        ['Thu', a.hours_thurs], ['Fri', a.hours_fri], ['Sat', a.hours_sat],
        ['Sun', a.hours_sun],
      ]),
      latitude: govNumber(f.geometry?.y),
      longitude: govNumber(f.geometry?.x),
      services: ['driver license', 'ID card', ...(cdl ? ['commercial driver license (CDL) testing'] : [])],
      cdl_testing: cdl,
      queue_camera_urls: [a.url_cam1, a.url_cam2, a.url_cam3, a.url_cam4]
        .filter((u): u is string => typeof u === 'string' && u.trim() !== ''),
      wait_times_url: (a.waittimes_widget as string) ?? null,
      status_note: typeof a.StatusNote === 'string' && a.StatusNote.trim() ? a.StatusNote.trim() : null,
      url: (a.url_page as string) ?? null,
    };
  });
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ia_dmv_driver_license_stations',
    description:
      'Find Iowa DOT driver license stations with street address, per-day opening hours, phone, coordinates, whether the station does commercial driver license (CDL) testing, and the live queue-camera image URLs Iowa points at its own waiting rooms so a caller can see how long the line is right now. Covers all 18 Motor Vehicle Division stations statewide, so it answers "Iowa driver license station in Des Moines", "where can I take the CDL test in Iowa", "what time does the Mason City DL station open on Saturday", or "show me the wait at an Iowa DMV". Filter by city, station name or CDL testing; call with no arguments for all 18.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, matched as a substring, e.g. "Des Moines", "Mason City", "Cedar Rapids".' },
        name: { type: 'string', description: 'Station-name substring, e.g. "Mason City", "Ankeny".' },
        cdl_only: { type: ['boolean', 'string'], description: 'Set true to keep only stations that perform commercial driver license (CDL) testing.' },
        limit: { type: ['number', 'string'], description: 'Max stations to return (default 20, max 50).' },
      },
    },
  },
];

function truthy(v: unknown): boolean {
  return v === true || /^(true|yes|y|1)$/i.test(String(v ?? ''));
}

async function driverLicenseStations(args: Record<string, unknown>): Promise<unknown> {
  let list = await loadStations();
  const statewide = list.length;
  if (!list.length) {
    return govNotFound(
      'upstream_empty',
      'Iowa DOT returned no driver license stations. Retry once — the ArcGIS Online feature service occasionally stalls and answers normally on the next call.',
    );
  }
  const city = govString(args, 'city');
  if (city) list = list.filter((s) => govContains(s.city, city) || govContains(s.name, city));
  const name = govString(args, 'name');
  if (name) list = list.filter((s) => govContains(s.name, name));
  const cdlOnly = truthy(args.cdl_only);
  if (cdlOnly) list = list.filter((s) => s.cdl_testing);
  if (!list.length) {
    return govNotFound(
      'no_matching_stations',
      `No Iowa driver license station matched those filters. Iowa runs only ${statewide} stations statewide, so most towns have none — drop \`city\` and call with no arguments for the full list, then pick the nearest by latitude and longitude.`,
      { filters_applied: { city, name, cdl_only: cdlOnly }, statewide_office_count: statewide },
    );
  }
  const limit = govLimit(args.limit, 20, 50);
  return {
    state: 'IA',
    source: 'Iowa DOT Motor Vehicle Division ArcGIS DLSv2_View — driver license stations',
    office_count: list.length,
    statewide_office_count: statewide,
    truncated: list.length > limit,
    offices: list.slice(0, limit),
    note: 'queue_camera_urls are live JPEG snapshots of the station lobby, refreshed by Iowa DOT; some stations also publish a closed-sign image on a second camera slot. wait_times_url is Iowa\'s own per-station wait widget. Hours list only the days a station is open.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'ia_dmv_driver_license_stations': return await driverLicenseStations(args);
      default:
        return govNotFound('unknown_tool', `ia-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `ia-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'The Iowa DOT feature service stalled. Retry the identical call once.'
        : 'services.arcgis.com refused the request or changed shape. Retry once; if it persists the DLSv2_View layer may have been republished under a new item id.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
