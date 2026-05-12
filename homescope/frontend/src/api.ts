export type AppConfig = {
  version: "1";
  connectionLabel: string;
  database: string;
  usernameConfigured: boolean;
  passwordConfigured: boolean;
  configured: boolean;
  source: "env" | "addon-options" | "defaults";
  missingFields: Array<"influx_url" | "influx_database" | "influx_username" | "influx_password">;
  error?: string;
};

export type Signal = {
  id: string;
  measurement: string;
  entityId: string;
  fullName: string;
  domain: string;
  field: "value" | "state";
  kind: "numeric" | "state";
  name: string;
  unit: string;
  group: string;
};

export type SignalResponse = {
  source: "influx" | "fixture" | "error";
  error?: string;
  signals: Signal[];
};

export type QuerySeries = {
  requestId: string;
  signalId: string;
  kind: "numeric" | "state";
  time: number[];
  values: Array<number | null>;
  states?: Array<string | null>;
  stateMap?: Record<string, number>;
};

export type QueryResponse = {
  source: "influx" | "fixture" | "error";
  error?: string;
  series: QuerySeries[];
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T;

  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : "";
    throw new Error(error || `Request failed with ${response.status}`);
  }

  return payload;
}

const apiBase = "api";

export function fetchConfig() {
  return fetchJson<AppConfig>(`${apiBase}/config`);
}

export function testConfig() {
  return fetchJson<{ ok: boolean; config: AppConfig }>(`${apiBase}/config/test`, {
    method: "POST"
  });
}

export function fetchSignals(params: { search?: string; measurement?: string; limit?: number }) {
  const searchParams = new URLSearchParams();
  if (params.search) {
    searchParams.set("search", params.search);
  }
  if (params.measurement) {
    searchParams.set("measurement", params.measurement);
  }
  if (params.limit) {
    searchParams.set("limit", String(params.limit));
  }

  const query = searchParams.toString();
  return fetchJson<SignalResponse>(`${apiBase}/signals${query ? `?${query}` : ""}`);
}

export function querySignals(params: {
  signal?: AbortSignal;
  signals: Array<string | { requestId: string; signalId: string }>;
  start: string;
  end: string;
  maxPoints: number;
}) {
  return fetchJson<QueryResponse>(`${apiBase}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      end: params.end,
      maxPoints: params.maxPoints,
      signals: params.signals,
      start: params.start
    }),
    signal: params.signal
  });
}
