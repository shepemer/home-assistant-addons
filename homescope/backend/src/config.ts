import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const AddonOptions = z.object({
  influx_url: z.string().default(""),
  influx_database: z.string().default(""),
  influx_username: z.string().default(""),
  influx_password: z.string().default("")
});

const RuntimeConfig = z.object({
  version: z.literal("1").default("1"),
  url: z.string().default(""),
  database: z.string().default(""),
  username: z.string().default(""),
  password: z.string().default(""),
  source: z.enum(["env", "addon-options", "defaults"]).default("defaults")
});

export type RuntimeConfig = z.infer<typeof RuntimeConfig>;
export type ConfigField = "influx_url" | "influx_database" | "influx_username" | "influx_password";

function loadDotEnv(path = resolve(process.cwd(), ".env")) {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadAddonOptions() {
  const optionsPath = process.env.ADDON_OPTIONS_PATH ?? "/data/options.json";

  if (!existsSync(optionsPath)) {
    return AddonOptions.parse({});
  }

  const raw = JSON.parse(readFileSync(optionsPath, "utf8")) as unknown;
  return AddonOptions.parse(raw);
}

export function loadRuntimeConfig(): RuntimeConfig {
  loadDotEnv();
  const addonOptions = loadAddonOptions();
  const hasEnvConfig = ["INFLUX_URL", "INFLUX_DATABASE", "INFLUX_USERNAME", "INFLUX_PASSWORD"].some(
    (key) => process.env[key] !== undefined
  );
  const optionsPath = process.env.ADDON_OPTIONS_PATH ?? "/data/options.json";
  const hasAddonOptions = existsSync(optionsPath);

  return RuntimeConfig.parse({
    version: "1",
    url: process.env.INFLUX_URL ?? addonOptions.influx_url,
    database: process.env.INFLUX_DATABASE ?? addonOptions.influx_database,
    username: process.env.INFLUX_USERNAME ?? addonOptions.influx_username,
    password: process.env.INFLUX_PASSWORD ?? addonOptions.influx_password,
    source: hasEnvConfig ? "env" : hasAddonOptions ? "addon-options" : "defaults"
  });
}

export function missingConfigFields(config: RuntimeConfig): ConfigField[] {
  const fields: ConfigField[] = [];
  if (!config.url.trim()) {
    fields.push("influx_url");
  }
  if (!config.database.trim()) {
    fields.push("influx_database");
  }
  if (!config.username.trim()) {
    fields.push("influx_username");
  }
  if (!config.password.trim()) {
    fields.push("influx_password");
  }
  return fields;
}

export function configValidationError(config: RuntimeConfig) {
  const missingFields = missingConfigFields(config);
  if (missingFields.length > 0) {
    return `Missing InfluxDB add-on option${missingFields.length === 1 ? "" : "s"}: ${missingFields.join(", ")}`;
  }

  try {
    const url = new URL(config.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "InfluxDB URL must start with http:// or https://";
    }
  } catch {
    return "InfluxDB URL is invalid";
  }

  return "";
}

export function assertRuntimeConfig(config: RuntimeConfig) {
  const validationError = configValidationError(config);
  if (validationError) {
    throw new Error(validationError);
  }
}

export function redactConfig(config: RuntimeConfig) {
  const validationError = configValidationError(config);
  return {
    version: config.version,
    connectionLabel:
      config.source === "env"
        ? "local environment"
        : config.source === "addon-options"
          ? "add-on options"
          : validationError
            ? "not configured"
            : "configured",
    database: config.database,
    usernameConfigured: config.username.length > 0,
    passwordConfigured: config.password.length > 0,
    configured: !validationError,
    source: config.source,
    missingFields: missingConfigFields(config),
    error: validationError || undefined
  };
}
