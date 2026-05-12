import express from "express";
import cors from "cors";
import morgan from "morgan";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { configValidationError, loadRuntimeConfig, redactConfig } from "./config.js";
import {
  discoverSignals,
  parseQueryBody,
  querySignals,
  testConnection
} from "./influx.js";
import sampleSignals from "../../frontend/src/fixtures/signals.json" with { type: "json" };
import sampleSeries from "../../frontend/src/fixtures/timeseries.json" with { type: "json" };

const app = express();
const port = Number(process.env.PORT ?? 8099);
const isProduction = process.env.NODE_ENV === "production";
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureSeries = sampleSeries.signals as Record<string, number[]>;
const fixtureSignals = sampleSignals.map((signal) => ({
  id: `${signal.unit}|fixture|${signal.id}|value`,
  measurement: signal.unit,
  entityId: signal.id,
  fullName: `fixture.${signal.id}`,
  domain: "fixture",
  field: "value",
  kind: "numeric",
  name: signal.name,
  unit: signal.unit,
  group: signal.group
}));

app.use(cors());
app.use(express.json());
app.use(morgan(isProduction ? ":remote-addr :method :url :status :res[content-length] - :response-time ms" : "dev"));

function getConfig() {
  return loadRuntimeConfig();
}

function errorMessage(error: unknown) {
  if (error instanceof ZodError) {
    return error.errors.map((issue) => issue.message).join(", ");
  }

  return error instanceof Error ? error.message : "Unexpected server error";
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "homescope" });
});

app.get("/api/config", (_req, res) => {
  const config = getConfig();
  res.json(redactConfig(config));
});

app.post("/api/config/test", async (_req, res) => {
  try {
    const config = getConfig();
    const validationError = configValidationError(config);
    if (validationError) {
      res.status(400).json({ ok: false, error: validationError, config: redactConfig(config) });
      return;
    }

    await testConnection(config);
    res.json({ ok: true, config: redactConfig(config) });
  } catch (error) {
    res.status(502).json({ ok: false, error: errorMessage(error) });
  }
});

app.get("/api/signals", async (req, res) => {
  try {
    const config = getConfig();
    const redacted = redactConfig(config);

    if (!redacted.configured) {
      res.json({
        source: "fixture",
        signals: fixtureSignals
      });
      return;
    }

    const search = typeof req.query.search === "string" ? req.query.search : "";
    const measurement = typeof req.query.measurement === "string" ? req.query.measurement : "";
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const signals = await discoverSignals(config, { search, measurement, limit });

    res.json({
      source: "influx",
      signals
    });
  } catch (error) {
    res.status(502).json({ source: "error", error: errorMessage(error), signals: [] });
  }
});

app.post("/api/query", async (req, res) => {
  try {
    const config = getConfig();
    const redacted = redactConfig(config);
    const body = parseQueryBody(req.body);

    if (!redacted.configured) {
      res.json({
        source: "fixture",
        series: body.signals.map((signalId) => ({
          requestId: typeof signalId === "string" ? signalId : signalId.requestId,
          signalId: typeof signalId === "string" ? signalId : signalId.signalId,
          kind: "numeric",
          time: sampleSeries.time,
          values:
            fixtureSeries[typeof signalId === "string" ? signalId : signalId.signalId] ??
            fixtureSeries[(typeof signalId === "string" ? signalId : signalId.signalId).split("|")[2]] ??
            fixtureSeries[(typeof signalId === "string" ? signalId : signalId.signalId).split("|")[1]] ??
            []
        }))
      });
      return;
    }

    const series = await querySignals(config, body);
    res.json({ source: "influx", series });
  } catch (error) {
    res.status(502).json({ source: "error", error: errorMessage(error), series: [] });
  }
});

app.get("/api/timeseries", (_req, res) => {
  res.json(sampleSeries);
});

if (isProduction) {
  const frontendDist = resolve(__dirname, "../frontend");
  app.use(express.static(frontendDist));
  app.get("*", (_req, res) => {
    res.sendFile(resolve(frontendDist, "index.html"));
  });
}

app.listen(port, "0.0.0.0", () => {
  console.log(`HomeScope listening on http://0.0.0.0:${port}`);
});
