import { Buffer } from "node:buffer";
import { expect, test, type Page } from "@playwright/test";

type Signal = {
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

type QueryRequest = {
  requestId: string;
  signalId: string;
};

const primarySignals: Signal[] = [
  makeNumericSignal("green_power", "sensor.emporia_vue_gen3_balance_power"),
  makeNumericSignal("total_power", "sensor.emporia_vue_gen3_total_power"),
  makeNumericSignal("blue_power", "sensor.emporia_vue_gen3_phase_a_power"),
  makeStateSignal("hvac_mode", "sensor.office_air_conditioner_mode")
];

const catalogSignals: Signal[] = [
  ...primarySignals,
  ...Array.from({ length: 1096 }, (_value, index) =>
    makeStateSignal(`automation_${index}`, `automation.generated_test_signal_${index}`)
  )
];

let lastQueryBody: {
  end: string;
  maxPoints: number;
  signals: QueryRequest[];
  start: string;
} | null = null;
let queryBodies: NonNullable<typeof lastQueryBody>[] = [];

function makeNumericSignal(entityId: string, fullName: string): Signal {
  const domain = fullName.split(".")[0];
  return {
    id: `W|${domain}|${entityId}|value`,
    measurement: "W",
    entityId,
    fullName,
    domain,
    field: "value",
    kind: "numeric",
    name: fullName,
    unit: "W",
    group: "sensor"
  };
}

function makeStateSignal(entityId: string, fullName: string): Signal {
  const domain = fullName.split(".")[0];
  return {
    id: `state|${domain}|${entityId}|state`,
    measurement: "state",
    entityId,
    fullName,
    domain,
    field: "state",
    kind: "state",
    name: fullName,
    unit: "state",
    group: domain
  };
}

function valuesForSignal(signalId: string, index: number, durationHours: number) {
  const durationOffset = Math.round(durationHours);
  if (signalId.includes("total_power")) {
    return 540 + durationOffset;
  }
  if (signalId.includes("blue_power")) {
    return 260 + durationOffset;
  }
  if (signalId.includes("green_power")) {
    return index % 10 === 0 ? -80 - durationOffset : -40 - durationOffset;
  }
  return 120 + index + durationOffset;
}

function numericSeries(request: QueryRequest, startSeconds: number, endSeconds: number) {
  const points = 80;
  const step = (endSeconds - startSeconds) / (points - 1);
  const time = Array.from({ length: points }, (_value, index) => Math.round(startSeconds + step * index));
  const durationHours = (endSeconds - startSeconds) / 3600;

  return {
    requestId: request.requestId,
    signalId: request.signalId,
    kind: "numeric",
    time,
    values: time.map((_time, index) => valuesForSignal(request.signalId, index, durationHours))
  };
}

function stateSeries(request: QueryRequest, startSeconds: number, endSeconds: number) {
  const mid = Math.round((startSeconds + endSeconds) / 2);
  return {
    requestId: request.requestId,
    signalId: request.signalId,
    kind: "state",
    time: [startSeconds, mid, endSeconds],
    values: [0, 1, 1],
    states: ["off", "cool", "cool"],
    stateMap: {
      off: 0,
      cool: 1
    }
  };
}

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/[\s_.-]+/g, " ").trim();
}

async function setupMockApi(page: Page) {
  lastQueryBody = null;
  queryBodies = [];
  await page.route("**/api/config/test", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        ok: true,
        config: configPayload()
      }
    });
  });
  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: configPayload()
    });
  });
  await page.route("**/api/signals**", async (route) => {
    const url = new URL(route.request().url());
    const search = normalizeSearch(url.searchParams.get("search") ?? "");
    const signals = search
      ? catalogSignals.filter((signal) =>
          normalizeSearch(`${signal.fullName} ${signal.entityId} ${signal.unit} ${signal.kind}`).includes(search)
        )
      : catalogSignals;

    await route.fulfill({
      contentType: "application/json",
      json: {
        source: "influx",
        signals
      }
    });
  });
  await page.route("**/api/query", async (route) => {
    lastQueryBody = route.request().postDataJSON();
    queryBodies.push(lastQueryBody!);
    const startSeconds = Math.floor(Date.parse(lastQueryBody!.start) / 1000);
    const endSeconds = Math.floor(Date.parse(lastQueryBody!.end) / 1000);

    await route.fulfill({
      contentType: "application/json",
      json: {
        source: "influx",
        series: lastQueryBody!.signals.map((request) =>
          request.signalId.startsWith("state|")
            ? stateSeries(request, startSeconds, endSeconds)
            : numericSeries(request, startSeconds, endSeconds)
        )
      }
    });
  });
}

function configPayload() {
  return {
    version: "1",
    connectionLabel: "local environment",
    database: "homeassistant",
    usernameConfigured: true,
    passwordConfigured: true,
    configured: true,
    source: "env",
    missingFields: []
  };
}

function unconfiguredPayload() {
  return {
    version: "1",
    connectionLabel: "add-on options",
    database: "homeassistant",
    usernameConfigured: false,
    passwordConfigured: false,
    configured: false,
    source: "addon-options",
    missingFields: ["influx_username", "influx_password"],
    error: "Missing InfluxDB add-on options: influx_username, influx_password"
  };
}

async function gotoWorkbench(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("signal-row-W|sensor|green_power|value")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await setupMockApi(page);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await gotoWorkbench(page);
});

test("keeps saved workspaces below an independently scrollable signal catalog", async ({ page }) => {
  const listBox = await page.locator(".signal-list").boundingBox();
  const savedBox = await page.locator(".saved-views").boundingBox();
  expect(listBox).not.toBeNull();
  expect(savedBox).not.toBeNull();
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(savedBox!.y);

  const scrollMetrics = await page.locator(".signal-list").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
});

test("shows setup state without exposing credentials when InfluxDB options are incomplete", async ({ page }) => {
  await page.route("**/api/config/test", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      json: {
        ok: false,
        error: unconfiguredPayload().error,
        config: unconfiguredPayload()
      }
    });
  });
  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: unconfiguredPayload()
    });
  });
  await page.route("**/api/signals**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        source: "fixture",
        signals: primarySignals
      }
    });
  });
  await page.route("**/api/query", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        source: "fixture",
        series: []
      }
    });
  });

  await page.goto("/");
  await expect(page.getByText("Setup Required")).toBeVisible();
  await expect(page.getByText("Fixture data is shown until the InfluxDB add-on options are complete.")).toBeVisible();
  await expect(page.getByText("Setup fixtures")).toBeVisible();
  await expect(page.getByTestId("signal-row-W|sensor|green_power|value")).toBeVisible();
  await expect(page.getByText("temporarypassword")).toHaveCount(0);
});

test("adds duplicate panes and overlays same-unit signals by dragging", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|green_power|value").click();
  await page.getByTestId("signal-row-W|sensor|green_power|value").click();
  await expect(page.getByTestId("signal-lane")).toHaveCount(2);

  await page.getByTestId("signal-row-W|sensor|total_power|value").dragTo(page.getByTestId("signal-lane").first(), {
    targetPosition: { x: 260, y: 130 }
  });

  await expect(page.getByTestId("signal-lane").first().locator(".lane-signal-chip")).toHaveCount(2);
});

test("selects the overlaid line nearest to the mouse pointer", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|green_power|value").click();
  await page.getByTestId("signal-row-W|sensor|total_power|value").dragTo(page.getByTestId("signal-lane").first(), {
    targetPosition: { x: 260, y: 130 }
  });
  await page.getByTestId("signal-row-W|sensor|blue_power|value").dragTo(page.getByTestId("signal-lane").first(), {
    targetPosition: { x: 260, y: 130 }
  });
  await expect(page.getByTestId("signal-lane").first().locator(".lane-signal-chip")).toHaveCount(3);
  await expect(page.getByTestId("axis-gutter-left").first().locator(".axis-tick")).toHaveText([
    "600",
    "400",
    "200",
    "0",
    "-200"
  ]);

  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();

  await page.mouse.move(plotBox!.x + plotBox!.width / 2, plotBox!.y + 28);
  await expect(page.getByTestId("cursor-tooltip")).toContainText("sensor.emporia_vue_gen3_total_power");
});

test("renders rounded ordered y-axis ticks for multi-signal panes", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|green_power|value").click();
  await page.getByTestId("signal-row-W|sensor|total_power|value").dragTo(page.getByTestId("signal-lane").first(), {
    targetPosition: { x: 260, y: 130 }
  });
  await page.getByTestId("signal-row-W|sensor|blue_power|value").dragTo(page.getByTestId("signal-lane").first(), {
    targetPosition: { x: 260, y: 130 }
  });

  await expect(page.getByTestId("axis-gutter-left").first().locator(".axis-tick")).toHaveText([
    "600",
    "400",
    "200",
    "0",
    "-200"
  ]);
});

test("abbreviates large y-axis ticks with magnitude suffixes", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  await page.getByTestId(/^axis-settings-.*-left$/).click();
  await page.getByTestId("axis-config-popover").getByRole("button", { name: "Manual" }).click();
  await page.getByTestId("axis-min-input").fill("0");
  await page.getByTestId("axis-max-input").fill("10000");

  const tickLabels = page.getByTestId("axis-gutter-left").first().locator(".axis-tick");
  await expect(tickLabels).toContainText(["10K", "8K", "6K", "4K", "2K", "0"]);
  expect(await tickLabels.allTextContents()).not.toContain("10000");
});

test("keeps low negative overlay signals visible after double-click reset", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|green_power|value").click();
  await page.getByTestId("signal-row-W|sensor|total_power|value").dragTo(page.getByTestId("signal-lane").first(), {
    targetPosition: { x: 260, y: 130 }
  });
  await page.getByTestId("signal-row-W|sensor|blue_power|value").dragTo(page.getByTestId("signal-lane").first(), {
    targetPosition: { x: 260, y: 130 }
  });

  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();
  await page.mouse.dblclick(plotBox!.x + plotBox!.width / 2, plotBox!.y + plotBox!.height / 2);

  await expect(page.getByTestId("axis-gutter-left").first().locator(".axis-tick")).toHaveText([
    "600",
    "400",
    "200",
    "0",
    "-200"
  ]);
});

test("keeps 6h queries covering the full selected time range", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  await page.getByRole("button", { name: "6h" }).click();
  await expect.poll(() => lastQueryBody?.signals.length).toBe(1);
  await expect.poll(() => {
    const start = Date.parse(lastQueryBody!.start);
    const end = Date.parse(lastQueryBody!.end);
    return Math.round((end - start) / 3_600_000);
  }).toBe(6);
});

test("renders sparse state signals with carried boundary labels", async ({ page }) => {
  await page.getByTestId("signal-row-state|sensor|hvac_mode|state").click();

  const ticks = page.getByTestId("axis-gutter-left").first().locator(".axis-tick");
  await expect(ticks).toContainText(["off", "cool"]);

  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();
  await page.mouse.move(plotBox!.x + plotBox!.width * 0.75, plotBox!.y + 50);
  await expect(page.getByTestId("cursor-tooltip")).toContainText("cool");
});

test("keeps selection overlay inside the plot area", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  const plot = page.getByTestId("plot-shell").first();
  const plotBox = await plot.boundingBox();
  expect(plotBox).not.toBeNull();

  await page.mouse.move(plotBox!.x + 12, plotBox!.y + 80);
  await page.mouse.down();
  await page.mouse.move(plotBox!.x + plotBox!.width + 80, plotBox!.y + 84);

  const overlayBox = await page.getByTestId("chart-drag-overlay-x").boundingBox();
  expect(overlayBox).not.toBeNull();
  expect(overlayBox!.x).toBeGreaterThanOrEqual(plotBox!.x - 1);
  expect(overlayBox!.x + overlayBox!.width).toBeLessThanOrEqual(plotBox!.x + plotBox!.width + 1);

  await page.mouse.up();
});

test("restores, clears, and reloads local saved workspaces", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|green_power|value").click();
  await page.getByRole("button", { name: "Saved Workspaces" }).click();
  await page.getByPlaceholder("Workspace name").fill("Power view");
  await page.getByTitle("Save workspace").click();
  await expect(page.locator(".saved-workspace-row", { hasText: "Power view" })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("signal-lane")).toHaveCount(1);

  await page.getByRole("button", { name: "Clear workspace" }).click();
  await expect(page.getByTestId("signal-lane")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("influxVisualizer.workspace.v1")))
    .toBeNull();

  await page.getByRole("button", { name: "Saved Workspaces" }).click();
  await page.locator(".saved-workspace-row", { hasText: "Power view" }).getByRole("button").first().click();
  await expect(page.getByTestId("signal-lane")).toHaveCount(1);
});

test("drops missing signal ids when restoring a persisted workspace", async ({ page }) => {
  await page.evaluate(() => {
    window.localStorage.setItem(
      "influxVisualizer.workspace.v1",
      JSON.stringify({
        id: "current",
        name: "Current workspace",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        panes: [
          {
            paneId: "pane-with-missing-signal",
            axes: {
              left: ["W|sensor|green_power|value", "W|sensor|missing_power|value"],
              right: []
            }
          }
        ],
        paneYRanges: {},
        preset: "24h",
        rangeMode: "preset",
        viewportDurationMs: 86_400_000,
        panelWidths: {
          left: 306,
          right: 280
        }
      })
    );
  });

  await page.reload();
  await expect(page.getByTestId("signal-lane")).toHaveCount(1);
  await expect(page.getByTestId("signal-lane").first().locator(".lane-signal-chip")).toHaveCount(1);
  await expect(page.getByTestId("signal-lane").first()).toContainText("sensor.emporia_vue_gen3_balance_power");
});

test("applies signal styling and restores it after reload", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|green_power|value").click();
  const lane = page.getByTestId("signal-lane").first();

  await lane.getByTitle("Signal settings").first().click();
  await page.getByTestId("style-color-#f472b6").click();
  await lane.getByTitle("Signal settings").first().click();
  await expect(lane.locator(".lane-signal-chip .swatch").first()).toHaveCSS("background-color", "rgb(244, 114, 182)");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(window.localStorage.getItem("influxVisualizer.workspace.v1") ?? "{}");
        return Object.values(workspace.signalConfigs ?? {})[0];
      })
    )
    .toMatchObject({ color: "#f472b6" });

  await page.reload();
  await expect(page.getByTestId("signal-lane")).toHaveCount(1);
  await expect(page.getByTestId("signal-lane").first().locator(".lane-signal-chip .swatch").first()).toHaveCSS(
    "background-color",
    "rgb(244, 114, 182)"
  );
});

test("manual axis settings apply, persist, and reset to auto", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  const lane = page.getByTestId("signal-lane").first();

  await lane.getByRole("button", { name: "left" }).click();
  await page.getByTestId("axis-config-popover").getByRole("button", { name: "Manual" }).click();
  await page.getByTestId("axis-min-input").fill("100");
  await page.getByTestId("axis-max-input").fill("900");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(window.localStorage.getItem("influxVisualizer.workspace.v1") ?? "{}");
        const key = Object.keys(workspace.axisConfigs ?? {}).find((nextKey) => nextKey.endsWith(":left"));
        return key ? workspace.axisConfigs[key] : null;
      })
    )
    .toMatchObject({ max: 900, min: 100, mode: "manual" });

  await page.getByTestId("axis-config-popover").getByRole("button", { name: "Reset axis" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(window.localStorage.getItem("influxVisualizer.workspace.v1") ?? "{}");
        return Object.keys(workspace.axisConfigs ?? {}).filter((nextKey) => nextKey.endsWith(":left")).length;
      })
    )
    .toBe(0);
});

test("vertical drag creates manual axis config and double-click resets it", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();

  await page.mouse.move(plotBox!.x + plotBox!.width / 2, plotBox!.y + 25);
  await page.mouse.down();
  await page.mouse.move(plotBox!.x + plotBox!.width / 2 + 2, plotBox!.y + plotBox!.height - 25);
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(window.localStorage.getItem("influxVisualizer.workspace.v1") ?? "{}");
        const key = Object.keys(workspace.axisConfigs ?? {}).find((nextKey) => nextKey.endsWith(":left"));
        return key ? workspace.axisConfigs[key]?.mode : null;
      })
    )
    .toBe("manual");

  await page.mouse.dblclick(plotBox!.x + plotBox!.width / 2, plotBox!.y + plotBox!.height / 2);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(window.localStorage.getItem("influxVisualizer.workspace.v1") ?? "{}");
        return Object.keys(workspace.axisConfigs ?? {}).filter((nextKey) => nextKey.endsWith(":left")).length;
      })
    )
    .toBe(0);
});

test("numeric and state stats update from visible query data", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  const lane = page.getByTestId("signal-lane").first();
  await lane.getByTitle("Signal settings").first().click();
  await expect(page.getByTestId("signal-stats")).toContainText("564.0 W");

  await page.getByRole("button", { name: "6h" }).click();
  await expect(page.getByTestId("signal-stats")).toContainText("546.0 W");

  await page.getByTestId("signal-row-state|sensor|hvac_mode|state").click();
  await page.getByTestId("signal-lane").nth(1).getByTitle("Signal settings").first().click();
  await expect(page.getByTestId("signal-stats").last()).toContainText("Transitions");
  await expect(page.getByTestId("signal-stats").last()).toContainText("cool");
});

test("creates, edits, deletes, and persists local markers", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();

  await page.getByTestId("marker-mode-button").click();
  await page.mouse.click(plotBox!.x + plotBox!.width / 2, plotBox!.y + plotBox!.height / 2);
  await expect(page.getByTestId("chart-marker")).toHaveCount(1);
  await expect(page.getByTestId("marker-row")).toHaveCount(1);

  await page.getByTestId("marker-row").locator("input").fill("Event A");
  await page.reload();
  await expect(page.getByTestId("chart-marker")).toHaveCount(1);
  await expect(page.getByTestId("marker-row").locator("input")).toHaveValue("Event A");

  await page.getByTestId("marker-row").getByTitle("Delete marker").click();
  await expect(page.getByTestId("chart-marker")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(window.localStorage.getItem("influxVisualizer.workspace.v1") ?? "{}");
        return workspace.markers?.length ?? 0;
      })
    )
    .toBe(0);
});

test("places A/B measurement cursors and reports numeric value deltas", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();

  await page.mouse.click(plotBox!.x + plotBox!.width / 2, plotBox!.y + 32);
  await expect(page.getByTestId("selected-signal-card")).toContainText("sensor.emporia_vue_gen3_total_power");

  await page.keyboard.press("a");
  await page.mouse.click(plotBox!.x + plotBox!.width * 0.28, plotBox!.y + plotBox!.height / 2);
  await page.keyboard.press("b");
  await page.mouse.click(plotBox!.x + plotBox!.width * 0.72, plotBox!.y + plotBox!.height / 2);

  await expect(page.getByTestId("measurement-cursor-A")).toHaveCount(1);
  await expect(page.getByTestId("measurement-cursor-B")).toHaveCount(1);
  await expect(page.getByTestId("measurement-delta-time")).not.toHaveText("--");
  await expect(page.getByTestId("measurement-delta-value")).toContainText(/0(?:\.00)? W/);
});

test("reports A/B state changes for selected state signals", async ({ page }) => {
  await page.getByTestId("signal-row-state|sensor|hvac_mode|state").click();
  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();

  await page.mouse.click(plotBox!.x + plotBox!.width * 0.08, plotBox!.y + plotBox!.height * 0.75);
  await expect(page.getByTestId("selected-signal-card")).toContainText("sensor.office_air_conditioner_mode");

  await page.getByRole("button", { name: "Place A measurement cursor" }).click();
  await page.mouse.click(plotBox!.x + plotBox!.width * 0.08, plotBox!.y + plotBox!.height / 2);
  await page.getByRole("button", { name: "Place B measurement cursor" }).click();
  await page.mouse.click(plotBox!.x + plotBox!.width * 0.92, plotBox!.y + plotBox!.height / 2);

  const measurementCard = page.getByTestId("measurement-card");
  await expect(measurementCard).toContainText("off");
  await expect(measurementCard).toContainText("cool");
  await expect(page.getByTestId("measurement-delta-value")).toHaveText("Changed");
});

test("creates and persists derived signals without querying the derived id", async ({ page }) => {
  await page.getByRole("button", { name: "Derived Signal" }).click();
  await page.getByLabel("Derived signal name").fill("Load delta");
  await page.getByLabel("Derived signal variables").fill("total_power, blue_power");
  await page.getByLabel("Derived signal formula").fill("total_power - blue_power");
  await page.getByLabel("Derived signal unit").fill("W");
  await page.getByRole("button", { name: "Create derived signal" }).click();

  const derivedRow = page.getByRole("button", { name: /Add signal derived\.Load delta/ });
  await expect(derivedRow).toBeVisible();
  await derivedRow.click();
  await expect(page.getByTestId("signal-lane")).toHaveCount(1);
  await expect(page.getByTestId("signal-lane").first()).toContainText("derived.Load delta");

  await expect.poll(() => lastQueryBody?.signals.length).toBe(2);
  expect(lastQueryBody!.signals.some((request) => request.signalId.startsWith("derived|"))).toBe(false);

  await page.reload();
  await expect(page.getByTestId("signal-lane")).toHaveCount(1);
  await expect(page.getByTestId("signal-lane").first()).toContainText("derived.Load delta");
});

test("renders event overlays from state signal transitions", async ({ page }) => {
  await page.getByTestId("signal-row-state|sensor|hvac_mode|state").click();
  await page.locator("[data-testid^='signal-settings-']").first().click();
  await page.getByTestId("event-source-toggle-state|sensor|hvac_mode|state").check();

  await expect(page.getByTestId("event-overlay")).toHaveCount(1);
  await expect(page.getByTestId("event-overlay").first()).toContainText("cool");
});

test("exports and imports marker JSON", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();

  await page.getByTestId("marker-mode-button").click();
  await page.mouse.click(plotBox!.x + plotBox!.width / 2, plotBox!.y + plotBox!.height / 2);
  await page.getByTestId("marker-row").locator("input").fill("Exported marker");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export markers" }).click()
  ]);
  expect(download.suggestedFilename()).toBe("homescope-markers.json");

  const markerPayload = await page.evaluate(() => {
    const workspace = JSON.parse(window.localStorage.getItem("influxVisualizer.workspace.v1") ?? "{}");
    return JSON.stringify({ version: 1, markers: workspace.markers ?? [] });
  });

  await page.getByTestId("marker-row").getByTitle("Delete marker").click();
  await expect(page.getByTestId("marker-row")).toHaveCount(0);

  await page.getByTestId("marker-import-input").setInputFiles({
    name: "markers.json",
    mimeType: "application/json",
    buffer: Buffer.from(markerPayload)
  });
  await expect(page.getByTestId("marker-row")).toHaveCount(1);
  await expect(page.getByTestId("marker-row").locator("input")).toHaveValue("Exported marker");
});

test("keyboard arrows pan only while a chart pane is hovered", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  await expect.poll(() => lastQueryBody?.signals.length).toBe(1);
  const initialStart = lastQueryBody!.start;

  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  expect(lastQueryBody!.start).toBe(initialStart);

  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();
  await page.mouse.move(plotBox!.x + plotBox!.width / 2, plotBox!.y + plotBox!.height / 2);
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Active in panes");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowRight");

  await expect.poll(() => lastQueryBody!.start).not.toBe(initialStart);
});

test("keyboard zoom modes zoom x and y and clear on mouse leave", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();
  await page.mouse.move(plotBox!.x + plotBox!.width / 2, plotBox!.y + plotBox!.height / 2);
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Active in panes");
  await expect.poll(() => lastQueryBody?.signals.length).toBe(1);
  const initialDuration = Date.parse(lastQueryBody!.end) - Date.parse(lastQueryBody!.start);

  await page.keyboard.press("x");
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Zoom X");
  await page.keyboard.press("e");
  await expect.poll(() => Date.parse(lastQueryBody!.end) - Date.parse(lastQueryBody!.start)).toBeLessThan(initialDuration);

  await page.keyboard.press("y");
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Zoom Y");
  await page.keyboard.press("e");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(window.localStorage.getItem("influxVisualizer.workspace.v1") ?? "{}");
        const key = Object.keys(workspace.axisConfigs ?? {}).find((nextKey) => nextKey.endsWith(":left"));
        return key ? workspace.axisConfigs[key]?.mode : null;
      })
    )
    .toBe("manual");

  await page.keyboard.press("z");
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Zoom XY");
  await page.keyboard.press("e");

  const laneBox = await page.getByTestId("signal-lane").first().boundingBox();
  expect(laneBox).not.toBeNull();
  await page.mouse.move(laneBox!.x + 18, laneBox!.y + 18);
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Zoom XY");
  await page.mouse.move(plotBox!.x + plotBox!.width / 2, plotBox!.y + plotBox!.height / 2);
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Zoom XY");

  await page.mouse.move(5, 5);
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Zoom Off");
});

test("marker shortcuts and tooltip hints work", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  const markerButton = page.getByTestId("marker-mode-button");
  await markerButton.hover();
  await expect(page.getByText(/Press M while hovering panes/)).toBeVisible();

  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();
  await page.mouse.move(plotBox!.x + plotBox!.width / 2, plotBox!.y + plotBox!.height / 2);
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Active in panes");
  await page.keyboard.press("m");
  await expect(markerButton).toHaveClass(/active/);

  await page.mouse.click(plotBox!.x + plotBox!.width / 2, plotBox!.y + plotBox!.height / 2);
  await expect(page.getByTestId("chart-marker")).toHaveCount(1);

  await page.keyboard.down("Control");
  await page.mouse.click(plotBox!.x + plotBox!.width * 0.66, plotBox!.y + plotBox!.height / 2);
  await page.keyboard.up("Control");
  await expect(page.getByTestId("chart-marker")).toHaveCount(2);
});

test("interaction help documents shortcuts and closes with escape", async ({ page }) => {
  await page.getByTestId("interaction-help-button").click();
  const help = page.getByTestId("interaction-help-popover");
  await expect(help).toBeVisible();
  await expect(help).toContainText("Shortcuts apply while the mouse is in the panes area");
  await expect(help).toContainText("X / Y / Z");
  await expect(help).toContainText("E / D");
  await expect(help).toContainText("A / B");
  await expect(help).toContainText("Ctrl-click");
  await expect(help).toContainText("Double-click");

  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
});

test("inspector sections collapse and expand from their headings", async ({ page }) => {
  const cursorSection = page.getByTestId("inspector-section-cursor");
  const cursorHeading = cursorSection.getByRole("button", { name: "Cursor" });

  await expect(cursorHeading).toHaveAttribute("aria-expanded", "true");
  await cursorHeading.click();
  await expect(cursorHeading).toHaveAttribute("aria-expanded", "false");
  await expect(cursorSection).toHaveClass(/collapsed/);

  await cursorHeading.click();
  await expect(cursorHeading).toHaveAttribute("aria-expanded", "true");
  await expect(cursorSection).not.toHaveClass(/collapsed/);
});

test("important icon controls have labels and visible keyboard focus", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Toggle marker placement" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show keyboard and mouse shortcuts" }).first()).toBeVisible();

  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  await expect(page.getByRole("button", { name: "Close pane" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Signal settings for sensor\.emporia_vue_gen3_total_power/ })).toBeVisible();

  await page.keyboard.press("Tab");
  const focusedLabel = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  expect(focusedLabel).toContain("Add signal");
  await expect(page.locator(":focus")).toHaveCSS("outline-style", "solid");
});

test("clicking an overlaid waveform selects the nearest signal and shows stats", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|green_power|value").click();
  await page.getByTestId("signal-row-W|sensor|total_power|value").dragTo(page.getByTestId("signal-lane").first(), {
    targetPosition: { x: 260, y: 130 }
  });
  await page.getByTestId("signal-row-W|sensor|blue_power|value").dragTo(page.getByTestId("signal-lane").first(), {
    targetPosition: { x: 260, y: 130 }
  });

  const plotBox = await page.getByTestId("plot-shell").first().boundingBox();
  expect(plotBox).not.toBeNull();
  await page.mouse.click(plotBox!.x + plotBox!.width / 2, plotBox!.y + 28);

  await expect(page.getByTestId("selected-signal-card")).toContainText("sensor.emporia_vue_gen3_total_power");
  await expect(page.getByTestId("selected-signal-card")).toContainText("Mean");
  await expect(page.getByTestId("signal-lane").first().locator(".lane-signal-chip.selected")).toHaveCount(1);

  await page.mouse.click(plotBox!.x + plotBox!.width / 2, plotBox!.y + 28);
  await expect(page.getByTestId("selected-signal-card")).toContainText("None");
  await expect(page.getByTestId("signal-lane").first().locator(".lane-signal-chip.selected")).toHaveCount(0);
});

test("virtualizes a large catalog while keeping saved views fixed below it", async ({ page }) => {
  await expect(page.getByText("1100 catalog signals")).toBeVisible();
  const listBox = await page.locator(".signal-list").boundingBox();
  const savedBox = await page.locator(".saved-views").boundingBox();
  expect(listBox).not.toBeNull();
  expect(savedBox).not.toBeNull();
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(savedBox!.y);

  const renderedRows = await page.locator(".signal-row").count();
  expect(renderedRows).toBeLessThan(80);

  await page.locator(".signal-list").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByTestId("signal-row-state|automation|automation_1095|state")).toBeVisible();
});

test("narrow layout keeps inspector status available without catalog overlap", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 720 });
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  await expect(page.getByTestId("mobile-status-strip")).toBeVisible();
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Zoom Off");
  await expect(page.getByTestId("mobile-status-strip")).toContainText("Query");
  await expect(page.locator(".inspector-panel")).toBeHidden();

  const listBox = await page.locator(".signal-list").boundingBox();
  const savedBox = await page.locator(".saved-views").boundingBox();
  expect(listBox).not.toBeNull();
  expect(savedBox).not.toBeNull();
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(savedBox!.y);
});

test("coalesces duplicate visible signal requests while rendering duplicate panes", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  await expect(page.getByTestId("signal-lane")).toHaveCount(2);

  await expect.poll(() => lastQueryBody?.signals.length).toBe(1);
  await expect(page.getByTestId("unique-query-count")).toHaveText("1");
  await expect(page.locator(".readout-row", { hasText: "sensor.emporia_vue_gen3_total_power" })).toHaveCount(2);
});

test("keeps rapid preset changes on the latest viewport and adapts max points", async ({ page }) => {
  await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  await expect.poll(() => lastQueryBody?.signals.length).toBe(1);

  await page.getByRole("button", { name: "7d" }).click();
  await expect.poll(() => {
    const body = lastQueryBody;
    if (!body) {
      return 0;
    }
    return Math.round((Date.parse(body.end) - Date.parse(body.start)) / 86_400_000);
  }).toBe(7);
  const sevenDayPoints = lastQueryBody!.maxPoints;

  await page.getByRole("button", { name: "6h" }).click();
  await page.getByRole("button", { name: "1m" }).click();
  await expect.poll(() => {
    const body = lastQueryBody;
    if (!body) {
      return 0;
    }
    return Math.round((Date.parse(body.end) - Date.parse(body.start)) / 60_000);
  }).toBe(1);

  expect(lastQueryBody!.maxPoints).toBeGreaterThan(sevenDayPoints);
  expect(lastQueryBody!.maxPoints).toBeLessThanOrEqual(5000);
  expect(queryBodies.at(-1)?.start).toBe(lastQueryBody!.start);
});

test("keeps many panes scrollable and reports unique query status", async ({ page }) => {
  for (let index = 0; index < 14; index += 1) {
    await page.getByTestId("signal-row-W|sensor|total_power|value").click();
  }
  await expect(page.getByTestId("signal-lane")).toHaveCount(14);
  await expect.poll(() => lastQueryBody?.signals.length).toBe(1);

  const scrollMetrics = await page.locator(".chart-grid").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
  await expect(page.getByTestId("unique-query-count")).toHaveText("1");
});
