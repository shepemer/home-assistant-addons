import { z } from "zod";
import { assertRuntimeConfig, type RuntimeConfig } from "./config.js";

type SignalField = "value" | "state";
type SignalKind = "numeric" | "state";

export type Signal = {
  id: string;
  measurement: string;
  entityId: string;
  fullName: string;
  domain: string;
  field: SignalField;
  kind: SignalKind;
  name: string;
  unit: string;
  group: string;
};

export type QuerySignal = {
  requestId: string;
  signalId: string;
  measurement: string;
  domain: string;
  entityId: string;
  field: SignalField;
  kind: SignalKind;
};

export type QuerySeries = {
  requestId: string;
  signalId: string;
  kind: SignalKind;
  time: number[];
  values: Array<number | null>;
  states?: Array<string | null>;
  stateMap?: Record<string, number>;
};

const QueryRequest = z.union([
  z.string(),
  z.object({
    requestId: z.string().min(1),
    signalId: z.string().min(1)
  })
]);

const QueryBody = z.object({
  signals: z.array(QueryRequest).min(1).max(48),
  start: z.string(),
  end: z.string(),
  maxPoints: z.number().int().min(50).max(5000).default(1600)
});

export type QueryBody = z.infer<typeof QueryBody>;

type InfluxSeries = {
  name?: string;
  columns?: string[];
  values?: unknown[][];
};

type InfluxResult = {
  statement_id?: number;
  error?: string;
  series?: InfluxSeries[];
};

type InfluxResponse = {
  error?: string;
  results?: InfluxResult[];
};

type CatalogCache = {
  expiresAt: number;
  key: string;
  signals: Signal[];
};

let catalogCache: CatalogCache | null = null;
const catalogTtlMs = 60_000;
const queryConcurrency = 4;

export class InfluxRequestError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "InfluxRequestError";
    this.status = status;
  }
}

export function parseQueryBody(body: unknown): QueryBody {
  return QueryBody.parse(body);
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function quoteString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function authHeader(config: RuntimeConfig): Record<string, string> {
  if (!config.username || !config.password) {
    return {};
  }

  return {
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
  };
}

export async function queryInflux(config: RuntimeConfig, query: string): Promise<InfluxResponse> {
  assertRuntimeConfig(config);

  const url = new URL("/query", config.url);
  url.searchParams.set("db", config.database);
  url.searchParams.set("q", query);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: authHeader(config)
    });
  } catch {
    throw new InfluxRequestError("Could not connect to InfluxDB. Check the URL, port, SSL setting, and network access.");
  }

  const text = await response.text();
  let payload: InfluxResponse = {};
  try {
    payload = text ? (JSON.parse(text) as InfluxResponse) : {};
  } catch {
    throw new InfluxRequestError("InfluxDB returned an invalid response.", response.status);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new InfluxRequestError("InfluxDB rejected the configured username or password.", response.status);
    }

    throw new InfluxRequestError(payload.error ?? `InfluxDB request failed with HTTP ${response.status}.`, response.status);
  }

  const resultError = payload.results?.find((result) => result.error)?.error;
  if (payload.error || resultError) {
    const message = payload.error ?? resultError ?? "InfluxDB query failed.";
    if (/database not found|database .* not found|unknown database/i.test(message)) {
      throw new InfluxRequestError("InfluxDB database was not found. Check the configured database name.");
    }
    if (/authorization|authorized|authentication|permission|privilege/i.test(message)) {
      throw new InfluxRequestError("InfluxDB user does not have permission to read the configured database.");
    }
    throw new InfluxRequestError(message);
  }

  return payload;
}

function unescapeInflux(value: string) {
  return value.replace(/\\([,= ])/g, "$1");
}

function splitUnescaped(input: string, separator: string) {
  const parts: string[] = [];
  let current = "";
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === separator) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts;
}

function signalName(entityId: string) {
  return entityId
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeSearch(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s_.-]+/g, " ")
    .trim();
}

function matchesSearch(source: string, search: string) {
  const normalizedSource = normalizeSearch(source);
  const normalizedSearch = normalizeSearch(search);
  const compactSource = normalizedSource.replace(/\s/g, "");
  const compactSearch = normalizedSearch.replace(/\s/g, "");

  return (
    normalizedSource.includes(normalizedSearch) ||
    (compactSearch.length > 0 && compactSource.includes(compactSearch))
  );
}

function parseSeriesTags(key: string) {
  const [measurementPart, ...tagParts] = splitUnescaped(key, ",");
  const tags = new Map<string, string>();

  for (const tagPart of tagParts) {
    const [keyPart, ...valueParts] = splitUnescaped(tagPart, "=");
    if (keyPart && valueParts.length > 0) {
      tags.set(unescapeInflux(keyPart), unescapeInflux(valueParts.join("=")));
    }
  }

  return {
    measurement: unescapeInflux(measurementPart),
    domain: tags.get("domain") ?? "",
    entityId: tags.get("entity_id") ?? ""
  };
}

function signalFromSeriesKey(key: string): Signal | null {
  const { measurement, domain, entityId } = parseSeriesTags(key);

  if (!measurement || !entityId) {
    return null;
  }

  const kind: SignalKind = measurement === "state" ? "state" : "numeric";
  const field: SignalField = kind === "state" ? "state" : "value";
  const fullName = domain ? `${domain}.${entityId}` : entityId;

  return {
    id: makeSignalId(measurement, domain, entityId, field),
    measurement,
    entityId,
    fullName,
    domain,
    field,
    kind,
    name: fullName,
    unit: kind === "state" ? "state" : measurement,
    group: domain || measurement
  };
}

export function makeSignalId(measurement: string, domain: string, entityId: string, field: SignalField) {
  return `${measurement}|${domain}|${entityId}|${field}`;
}

function kindForSignal(measurement: string, field: SignalField): SignalKind {
  return measurement === "state" || field === "state" ? "state" : "numeric";
}

export function parseSignalId(input: string | { requestId: string; signalId: string }): QuerySignal {
  const signalId = typeof input === "string" ? input : input.signalId;
  const requestId = typeof input === "string" ? input : input.requestId;
  const parts = signalId.split("|");

  if (parts.length === 3 && (parts[2] === "value" || parts[2] === "state")) {
    const field = parts[2] as SignalField;

    return {
      requestId,
      signalId,
      measurement: parts[0],
      domain: "",
      entityId: parts[1],
      field,
      kind: kindForSignal(parts[0], field)
    };
  }

  if (parts.length !== 4 || (parts[3] !== "value" && parts[3] !== "state")) {
    throw new Error(`Invalid signal id: ${signalId}`);
  }

  const field = parts[3] as SignalField;

  return {
    requestId,
    signalId,
    measurement: parts[0],
    domain: parts[1],
    entityId: parts[2],
    field,
    kind: kindForSignal(parts[0], field)
  };
}

export async function testConnection(config: RuntimeConfig) {
  await queryInflux(config, "SHOW MEASUREMENTS LIMIT 1");
  return { ok: true };
}

async function listMeasurements(config: RuntimeConfig) {
  const payload = await queryInflux(config, "SHOW MEASUREMENTS");
  const values = payload.results?.[0]?.series?.[0]?.values ?? [];

  return values.map((row) => String(row[0] ?? "")).filter(Boolean);
}

async function buildCatalog(config: RuntimeConfig): Promise<Signal[]> {
  const measurements = await listMeasurements(config);
  const batches = await Promise.all(
    measurements.map(async (measurement) => {
      const payload = await queryInflux(
        config,
        `SHOW SERIES FROM ${quoteIdentifier(measurement)} LIMIT 10000`
      );
      const values = payload.results?.[0]?.series?.flatMap((series) => series.values ?? []) ?? [];
      return values
        .map((row) => signalFromSeriesKey(String(row[0] ?? "")))
        .filter((signal): signal is Signal => Boolean(signal));
    })
  );
  const seen = new Set<string>();

  return batches
    .flat()
    .filter((signal) => {
      if (seen.has(signal.id)) {
        return false;
      }
      seen.add(signal.id);
      return true;
    })
    .filter((signal, _index, signals) => {
      const hasStateSignal = signals.some((candidate) => candidate.fullName === signal.fullName && candidate.kind === "state");
      const isEntityMeasurementDuplicate =
        signal.kind === "numeric" &&
        hasStateSignal &&
        signal.measurement === signal.fullName &&
        signal.unit === signal.fullName;

      return !isEntityMeasurementDuplicate;
    })
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

async function getCatalog(config: RuntimeConfig) {
  const key = `${config.url}|${config.database}|${config.username}`;
  const now = Date.now();

  if (catalogCache && catalogCache.key === key && catalogCache.expiresAt > now) {
    return catalogCache.signals;
  }

  const signals = await buildCatalog(config);
  catalogCache = {
    expiresAt: now + catalogTtlMs,
    key,
    signals
  };
  return signals;
}

export async function discoverSignals(
  config: RuntimeConfig,
  options: { search?: string; measurement?: string; limit?: number }
): Promise<Signal[]> {
  const requestedLimit = options.limit ?? 500;
  const limit = Math.min(Math.max(requestedLimit, 1), 5000);
  const catalog = await getCatalog(config);
  const search = options.search?.trim() ?? "";

  return catalog
    .filter((signal) => !options.measurement || signal.measurement === options.measurement)
    .filter((signal) => {
      if (!search) {
        return true;
      }
      return matchesSearch(
        `${signal.fullName} ${signal.entityId} ${signal.name} ${signal.domain} ${signal.measurement} ${signal.field} ${signal.kind}`,
        search
      );
    })
    .slice(0, limit);
}

function intervalFor(start: Date, end: Date, maxPoints: number) {
  const durationMs = Math.max(end.getTime() - start.getTime(), 1);
  const seconds = Math.max(Math.ceil(durationMs / 1000 / maxPoints), 1);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  return `${Math.ceil(hours / 24)}d`;
}

function shouldUseRawNumeric(start: Date, end: Date, maxPoints: number) {
  const durationMs = end.getTime() - start.getTime();
  return durationMs <= 30 * 60_000 && durationMs / maxPoints <= 15_000;
}

function tagFilters(signal: QuerySignal) {
  const filters = [`${quoteIdentifier("entity_id")} = ${quoteString(signal.entityId)}`];
  if (signal.domain) {
    filters.push(`${quoteIdentifier("domain")} = ${quoteString(signal.domain)}`);
  }
  return filters.join(" AND ");
}

function parseTimeValue(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function parseNumericValue(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mapStates(states: Array<string | null>) {
  const stateMap: Record<string, number> = {};
  let nextValue = 0;

  return {
    stateMap,
    values: states.map((state) => {
      if (state === null) {
        return null;
      }

      if (stateMap[state] === undefined) {
        stateMap[state] = nextValue;
        nextValue += 1;
      }

      return stateMap[state];
    })
  };
}

function parseStateRows(rows: unknown[][]) {
  return rows
    .map((row) => {
      const time = parseTimeValue(row[0]);
      if (time === null) {
        return null;
      }

      return {
        time,
        state: row[1] === null || row[1] === undefined ? null : String(row[1])
      };
    })
    .filter((row): row is { state: string | null; time: number } => row !== null);
}

async function queryNumericSignal(
  config: RuntimeConfig,
  signal: QuerySignal,
  start: Date,
  end: Date,
  maxPoints: number
): Promise<QuerySeries> {
  const startNs = `${start.getTime()}000000`;
  const endNs = `${end.getTime()}000000`;
  const raw = shouldUseRawNumeric(start, end, maxPoints);
  const query = raw
    ? [
        `SELECT ${quoteIdentifier(signal.field)} AS value`,
        `FROM ${quoteIdentifier(signal.measurement)}`,
        `WHERE ${tagFilters(signal)}`,
        `AND time >= ${startNs} AND time <= ${endNs}`,
        `LIMIT ${maxPoints}`
      ].join(" ")
    : [
        `SELECT mean(${quoteIdentifier(signal.field)}) AS value`,
        `FROM ${quoteIdentifier(signal.measurement)}`,
        `WHERE ${tagFilters(signal)}`,
        `AND time >= ${startNs} AND time <= ${endNs}`,
        `GROUP BY time(${intervalFor(start, end, maxPoints)}) fill(none)`
      ].join(" ");
  const payload = await queryInflux(config, query);
  const rows = payload.results?.[0]?.series?.[0]?.values ?? [];
  const time: number[] = [];
  const values: Array<number | null> = [];

  for (const row of rows) {
    const parsedTime = parseTimeValue(row[0]);
    if (parsedTime === null) {
      continue;
    }

    time.push(parsedTime);
    values.push(parseNumericValue(row[1]));
  }

  return {
    requestId: signal.requestId,
    signalId: signal.signalId,
    kind: "numeric",
    time,
    values
  };
}

async function queryStateSignal(
  config: RuntimeConfig,
  signal: QuerySignal,
  start: Date,
  end: Date,
  maxPoints: number
): Promise<QuerySeries> {
  const startNs = `${start.getTime()}000000`;
  const endNs = `${end.getTime()}000000`;
  const inRangeQuery = [
    `SELECT ${quoteIdentifier(signal.field)} AS state`,
    `FROM ${quoteIdentifier(signal.measurement)}`,
    `WHERE ${tagFilters(signal)}`,
    `AND time >= ${startNs} AND time <= ${endNs}`,
    `LIMIT ${maxPoints}`
  ].join(" ");
  const previousQuery = [
    `SELECT ${quoteIdentifier(signal.field)} AS state`,
    `FROM ${quoteIdentifier(signal.measurement)}`,
    `WHERE ${tagFilters(signal)}`,
    `AND time < ${startNs}`,
    `ORDER BY time DESC LIMIT 1`
  ].join(" ");

  const [inRangePayload, previousPayload] = await Promise.all([
    queryInflux(config, inRangeQuery),
    queryInflux(config, previousQuery)
  ]);
  const inRangeRows = parseStateRows(inRangePayload.results?.[0]?.series?.[0]?.values ?? []);
  const previousRows = parseStateRows(previousPayload.results?.[0]?.series?.[0]?.values ?? []);
  const startSeconds = Math.floor(start.getTime() / 1000);
  const endSeconds = Math.floor(end.getTime() / 1000);
  const points: Array<{ state: string | null; time: number }> = [];
  const previous = previousRows[0];

  if (previous?.state !== null && previous?.state !== undefined) {
    points.push({
      state: previous.state,
      time: startSeconds
    });
  }

  points.push(...inRangeRows);

  const lastKnownState = [...points].reverse().find((point) => point.state !== null)?.state;
  if (lastKnownState !== undefined) {
    const lastPoint = points[points.length - 1];
    if (!lastPoint || lastPoint.time < endSeconds) {
      points.push({
        state: lastKnownState,
        time: endSeconds
      });
    }
  }

  const deduped = points
    .sort((left, right) => left.time - right.time)
    .filter((point, index, sorted) => index === sorted.length - 1 || point.time !== sorted[index + 1].time);

  const time = deduped.map((point) => point.time);
  const states = deduped.map((point) => point.state);

  const mapped = mapStates(states);

  return {
    requestId: signal.requestId,
    signalId: signal.signalId,
    kind: "state",
    time,
    values: mapped.values,
    states,
    stateMap: mapped.stateMap
  };
}

function queryKey(signal: QuerySignal, start: Date, end: Date, maxPoints: number) {
  return `${signal.signalId}|${start.toISOString()}|${end.toISOString()}|${maxPoints}`;
}

function cloneSeries(series: QuerySeries, signal: QuerySignal): QuerySeries {
  return {
    ...series,
    requestId: signal.requestId,
    signalId: signal.signalId,
    time: [...series.time],
    values: [...series.values],
    states: series.states ? [...series.states] : undefined,
    stateMap: series.stateMap ? { ...series.stateMap } : undefined
  };
}

async function runLimited<T>(tasks: Array<() => Promise<T>>, limit: number) {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await tasks[currentIndex]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export async function querySignals(config: RuntimeConfig, body: QueryBody): Promise<QuerySeries[]> {
  const start = new Date(body.start);
  const end = new Date(body.end);

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("Invalid query time range");
  }

  const signals = body.signals.map((request) => parseSignalId(request));
  const grouped = new Map<string, { primary: QuerySignal; requests: QuerySignal[] }>();

  for (const signal of signals) {
    const key = queryKey(signal, start, end, body.maxPoints);
    const existing = grouped.get(key);
    if (existing) {
      existing.requests.push(signal);
    } else {
      grouped.set(key, {
        primary: signal,
        requests: [signal]
      });
    }
  }

  const groups = [...grouped.values()];
  const uniqueSeries = await runLimited(
    groups.map((group) => async () =>
      group.primary.kind === "state"
        ? queryStateSignal(config, group.primary, start, end, body.maxPoints)
        : queryNumericSignal(config, group.primary, start, end, body.maxPoints)
    ),
    queryConcurrency
  );

  const byKey = new Map(groups.map((group, index) => [queryKey(group.primary, start, end, body.maxPoints), uniqueSeries[index]]));

  return signals.map((signal) => {
    const series = byKey.get(queryKey(signal, start, end, body.maxPoints));
    if (!series) {
      throw new Error(`Missing query result for ${signal.signalId}`);
    }
    return cloneSeries(series, signal);
  });
}
