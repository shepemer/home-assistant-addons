import { afterEach, describe, expect, it, vi } from "vitest";
import { configValidationError, redactConfig } from "../src/config.js";
import {
  discoverSignals,
  parseSignalId,
  queryInflux,
  querySignals,
  quoteIdentifier,
  quoteString
} from "../src/influx.js";
import type { RuntimeConfig } from "../src/config.js";

const config: RuntimeConfig = {
  version: "1",
  url: "http://influx.local:8086",
  database: "homeassistant",
  username: "visualizer",
  password: "secret",
  source: "defaults"
};

function responseFor(values?: unknown[][]) {
  return new Response(JSON.stringify({
    results: values
      ? [
          {
            series: [
              {
                values
              }
            ]
          }
        ]
      : [{ series: [] }]
  }));
}

function mockInflux(handler: (query: string) => unknown[][] | undefined) {
  const queries: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("q") ?? "";
    queries.push(query);
    return responseFor(handler(query));
  }));
  return queries;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InfluxDB query helpers", () => {
  it("escapes identifiers and string values for InfluxQL", () => {
    expect(quoteIdentifier('unit "quoted" \\ path')).toBe('"unit \\"quoted\\" \\\\ path"');
    expect(quoteString("fan speed, zone=lab \\ it's")).toBe("'fan speed, zone=lab \\\\ it\\'s'");
  });

  it("parses signal ids and preserves request identity", () => {
    expect(parseSignalId({ requestId: "pane:left:0", signalId: "W|sensor|total_power|value" })).toEqual({
      requestId: "pane:left:0",
      signalId: "W|sensor|total_power|value",
      measurement: "W",
      domain: "sensor",
      entityId: "total_power",
      field: "value",
      kind: "numeric"
    });
    expect(parseSignalId("state|sensor|hvac_mode|state").kind).toBe("state");
    expect(parseSignalId("W|legacy_power|value")).toEqual({
      requestId: "W|legacy_power|value",
      signalId: "W|legacy_power|value",
      measurement: "W",
      domain: "",
      entityId: "legacy_power",
      field: "value",
      kind: "numeric"
    });
    expect(() => parseSignalId("bad-signal-id")).toThrow("Invalid signal id");
  });

  it("keeps config responses redacted", () => {
    expect(redactConfig(config)).toEqual({
      version: "1",
      connectionLabel: "configured",
      database: "homeassistant",
      usernameConfigured: true,
      passwordConfigured: true,
      configured: true,
      source: "defaults",
      missingFields: [],
      error: undefined
    });
  });

  it("reports missing add-on options without crashing or exposing secrets", () => {
    const missingConfig: RuntimeConfig = {
      version: "1",
      url: "http://a0d7b954-influxdb:8086",
      database: "homeassistant",
      username: "",
      password: "",
      source: "addon-options"
    };

    expect(configValidationError(missingConfig)).toBe("Missing InfluxDB add-on options: influx_username, influx_password");
    expect(redactConfig(missingConfig)).toEqual({
      version: "1",
      connectionLabel: "add-on options",
      database: "homeassistant",
      usernameConfigured: false,
      passwordConfigured: false,
      configured: false,
      source: "addon-options",
      missingFields: ["influx_username", "influx_password"],
      error: "Missing InfluxDB add-on options: influx_username, influx_password"
    });
  });

  it("deduplicates entity measurement rows when a real state signal exists", async () => {
    mockInflux((query) => {
      if (query === "SHOW MEASUREMENTS") {
        return [["automation.back_door_left_open_notification"], ["state"]];
      }
      if (query.includes("SHOW SERIES FROM")) {
        return query.includes('"state"')
          ? [["state,domain=automation,entity_id=back_door_left_open_notification"]]
          : [["automation.back_door_left_open_notification,domain=automation,entity_id=back_door_left_open_notification"]];
      }
      return undefined;
    });

    const signals = await discoverSignals(
      {
        ...config,
        username: "catalog-dedupe-test"
      },
      {
        search: "back door left",
        limit: 20
      }
    );

    expect(signals).toEqual([
      expect.objectContaining({
        fullName: "automation.back_door_left_open_notification",
        id: "state|automation|back_door_left_open_notification|state",
        kind: "state",
        unit: "state"
      })
    ]);
  });

  it("keeps same entity ids from different domains as distinct catalog signals", async () => {
    mockInflux((query) => {
      if (query === "SHOW MEASUREMENTS") {
        return [["state"]];
      }
      if (query.includes("SHOW SERIES FROM")) {
        return [
          ["state,domain=sensor,entity_id=motion"],
          ["state,domain=binary_sensor,entity_id=motion"]
        ];
      }
      return undefined;
    });

    const signals = await discoverSignals(
      {
        ...config,
        username: "catalog-domain-collision-test"
      },
      {
        search: "motion",
        limit: 20
      }
    );

    expect(signals.map((signal) => signal.id)).toEqual([
      "state|binary_sensor|motion|state",
      "state|sensor|motion|state"
    ]);
  });

  it("classifies invalid InfluxDB URLs before querying", async () => {
    const invalidConfig: RuntimeConfig = {
      ...config,
      url: "a0d7b954-influxdb:8086"
    };

    expect(configValidationError(invalidConfig)).toBe("InfluxDB URL must start with http:// or https://");
    await expect(queryInflux(invalidConfig, "SHOW MEASUREMENTS LIMIT 1")).rejects.toThrow(
      "InfluxDB URL must start with http:// or https://"
    );
  });

  it("returns safe messages for failed InfluxDB auth and database errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "authorization failed for visualizer:secret" }), { status: 401 })));
    await expect(queryInflux(config, "SHOW MEASUREMENTS LIMIT 1")).rejects.toThrow(
      "InfluxDB rejected the configured username or password."
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{ error: "database not found: nope" }] }))));
    await expect(queryInflux(config, "SHOW MEASUREMENTS LIMIT 1")).rejects.toThrow(
      "InfluxDB database was not found. Check the configured database name."
    );
  });

  it("uses downsampled numeric queries for broad ranges", async () => {
    const queries = mockInflux(() => [["2026-05-09T00:00:00Z", 42]]);

    await querySignals(config, {
      signals: [{ requestId: "cpu", signalId: "%|sensor|cpu_usage|value" }],
      start: "2026-05-08T00:00:00.000Z",
      end: "2026-05-09T00:00:00.000Z",
      maxPoints: 2400
    });

    expect(queries[0]).toContain('SELECT mean("value") AS value');
    expect(queries[0]).toContain(`"domain" = 'sensor'`);
    expect(queries[0]).toContain("GROUP BY time(36s) fill(none)");
  });

  it("uses raw numeric queries for narrow ranges", async () => {
    const queries = mockInflux(() => [["2026-05-09T00:00:00Z", 42]]);

    await querySignals(config, {
      signals: [{ requestId: "cpu", signalId: "%|sensor|cpu_usage|value" }],
      start: "2026-05-09T00:00:00.000Z",
      end: "2026-05-09T00:01:00.000Z",
      maxPoints: 2400
    });

    expect(queries[0]).toContain('SELECT "value" AS value');
    expect(queries[0]).toContain(`"domain" = 'sensor'`);
    expect(queries[0]).not.toContain("GROUP BY");
  });

  it("downsamples 6h numeric ranges instead of truncating raw high-rate data", async () => {
    const queries = mockInflux(() => [["2026-05-09T00:00:00Z", 42]]);

    await querySignals(config, {
      signals: [{ requestId: "power", signalId: "W|sensor|total_power|value" }],
      start: "2026-05-09T00:00:00.000Z",
      end: "2026-05-09T06:00:00.000Z",
      maxPoints: 2400
    });

    expect(queries[0]).toContain('SELECT mean("value") AS value');
    expect(queries[0]).toContain("GROUP BY time(9s) fill(none)");
    expect(queries[0]).not.toContain("LIMIT 2400");
  });

  it("coalesces duplicate signal queries and clones results for each request id", async () => {
    const queries = mockInflux(() => [["2026-05-09T00:00:00Z", 42]]);

    const series = await querySignals(config, {
      signals: [
        { requestId: "pane-a:left:0", signalId: "W|sensor|total_power|value" },
        { requestId: "pane-b:left:0", signalId: "W|sensor|total_power|value" }
      ],
      start: "2026-05-09T00:00:00.000Z",
      end: "2026-05-09T06:00:00.000Z",
      maxPoints: 1600
    });

    expect(queries).toHaveLength(1);
    expect(series.map((entry) => entry.requestId)).toEqual(["pane-a:left:0", "pane-b:left:0"]);
    expect(series.map((entry) => entry.signalId)).toEqual(["W|sensor|total_power|value", "W|sensor|total_power|value"]);
    expect(series[0].time).toEqual(series[1].time);
    expect(series[0]).not.toBe(series[1]);
  });

  it("limits concurrent unique numeric signal queries", async () => {
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return responseFor([["2026-05-09T00:00:00Z", 42]]);
    }));

    await querySignals(config, {
      signals: Array.from({ length: 12 }, (_value, index) => ({
        requestId: `pane-${index}:left:0`,
        signalId: `W|sensor|power_${index}|value`
      })),
      start: "2026-05-09T00:00:00.000Z",
      end: "2026-05-09T06:00:00.000Z",
      maxPoints: 1600
    });

    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("extends state series to viewport boundaries with prior and last known states", async () => {
    mockInflux((query) =>
      query.includes("ORDER BY time DESC")
        ? [["2026-05-09T00:00:00Z", "off"]]
        : [["2026-05-09T10:30:00Z", "cool"]]
    );

    const [series] = await querySignals(config, {
      signals: [{ requestId: "mode", signalId: "state|sensor|hvac_mode|state" }],
      start: "2026-05-09T10:00:00.000Z",
      end: "2026-05-09T11:00:00.000Z",
      maxPoints: 2400
    });

    expect(series.time).toEqual([1778320800, 1778322600, 1778324400]);
    expect(series.states).toEqual(["off", "cool", "cool"]);
    expect(series.values).toEqual([0, 1, 1]);
  });

  it("does not invent a start state when no prior state exists", async () => {
    mockInflux((query) =>
      query.includes("ORDER BY time DESC")
        ? undefined
        : [["2026-05-09T10:30:00Z", "cool"]]
    );

    const [series] = await querySignals(config, {
      signals: [{ requestId: "mode", signalId: "state|sensor|hvac_mode|state" }],
      start: "2026-05-09T10:00:00.000Z",
      end: "2026-05-09T11:00:00.000Z",
      maxPoints: 2400
    });

    expect(series.time).toEqual([1778322600, 1778324400]);
    expect(series.states).toEqual(["cool", "cool"]);
  });

  it("keeps real in-window samples over synthetic duplicate boundary samples", async () => {
    mockInflux((query) =>
      query.includes("ORDER BY time DESC")
        ? [["2026-05-09T09:59:00Z", "off"]]
        : [["2026-05-09T10:00:00Z", "cool"]]
    );

    const [series] = await querySignals(config, {
      signals: [{ requestId: "mode", signalId: "state|sensor|hvac_mode|state" }],
      start: "2026-05-09T10:00:00.000Z",
      end: "2026-05-09T11:00:00.000Z",
      maxPoints: 2400
    });

    expect(series.time).toEqual([1778320800, 1778324400]);
    expect(series.states).toEqual(["cool", "cool"]);
  });
});
