// Exercise the real HomeScope client against a database populated by integration.py.
// Run via HomeScope's installed tsx; read credentials from stdin, never argv.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  discoverSignals,
  querySignals,
  testConnection
} from "../../homescope/backend/src/influx.ts";

const { url, username, password, recent_ms } = JSON.parse(readFileSync(0, "utf8"));
const config = { version: "1" as const, url, username, password, database: "homeassistant", source: "env" as const };

assert.deepEqual(await testConnection(config), { ok: true });
const catalog = await discoverSignals(config, { limit: "all" });
for (const id of [
  "°C|sensor|living_room_temp|value",
  "%|sensor|humidity|value",
  "W|sensor|total_power|value",
  "custom unit|sensor|custom_value|value",
  "state|binary_sensor|door|state",
  "state|sensor|door|state",
  "state|automation|evening|state"
]) {
  assert(catalog.some(signal => signal.id === id), `Missing real HomeScope catalog signal: ${id}`);
}
assert(!catalog.some(signal => signal.id === "automation.evening|automation|evening|value"));

const [raw] = await querySignals(config, {
  signals: ["°C|sensor|living_room_temp|value"],
  start: "2024-01-02T00:00:00.000Z",
  end: "2024-01-02T00:01:00.000Z",
  maxPoints: 1600
});
assert.deepEqual(raw.values, [21.5, 22.5]);
assert.deepEqual(raw.time, [1704153600, 1704153605]);

const [aggregated] = await querySignals(config, {
  signals: ["W|sensor|total_power|value"],
  start: "2024-01-02T00:00:00.000Z",
  end: "2024-01-02T06:00:00.000Z",
  maxPoints: 50
});
assert.deepEqual(aggregated.values, [150]);

const [state, otherDomain] = await querySignals(config, {
  signals: ["state|binary_sensor|door|state", "state|sensor|door|state"],
  start: "2024-01-02T00:00:00.000Z",
  end: "2024-01-02T00:01:00.000Z",
  maxPoints: 1600
});
assert.deepEqual(state.states, ["off", "on", "on"]);
assert.deepEqual(state.time, [1704153600, 1704153610, 1704153660]);
assert.deepEqual(otherDomain.states, ['Open, after "rain"', 'Open, after "rain"']);

assert(Number.isFinite(recent_ms), "Recent fixture timestamp is required");
const [recent] = await querySignals(config, {
  signals: ["°C|sensor|living_room_temp|value"],
  start: new Date(recent_ms - 1000).toISOString(),
  end: new Date(recent_ms + 1000).toISOString(),
  maxPoints: 1600
});
assert.deepEqual(recent.values, [23.75]);
assert.deepEqual(recent.time, [Math.floor(recent_ms / 1000)]);
console.log("PASS actual HomeScope discovery, historical/recent raw numeric, mean aggregation, state boundary and domain queries");
