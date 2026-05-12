import React from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  CalendarClock,
  ChevronDown,
  Clock3,
  Crosshair,
  FolderTree,
  GripVertical,
  HelpCircle,
  MapPin,
  Pause,
  Play,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  X,
  Zap
} from "lucide-react";
import "uplot/dist/uPlot.min.css";
import {
  fetchConfig,
  fetchSignals,
  querySignals,
  testConfig,
  type AppConfig,
  type QuerySeries,
  type Signal
} from "./api";
import {
  UPlotLane,
  type AxisConfig,
  type AxisSide,
  type CursorHover,
  type EventOverlay,
  type LaneItem,
  type Marker,
  type MeasurementCursor,
  type PlotInteraction,
  type ScaleRange,
  type SignalViewConfig
} from "./UPlotLane";
import "./styles.css";

type Pane = {
  axes: Record<AxisSide, string[]>;
  paneId: string;
};

type TimeRange = {
  start: Date;
  end: Date;
};

type RangeMode = "preset" | "custom";
type KeyboardZoomMode = "none" | "x" | "y" | "xy";

type OverviewDrag = {
  durationMs: number;
  pointerId: number;
  startMs: number;
  x: number;
};

type PanelResize = {
  initialLeftWidth: number;
  initialRightWidth: number;
  side: "left" | "right";
  startX: number;
};

type PaneDropTarget = {
  paneId: string;
  side: AxisSide;
} | null;

type ReorderTarget = {
  paneId: string;
  position: "before" | "after";
} | null;

type SignalInsertTarget = {
  index: number;
} | null;

type DerivedSignal = {
  id: string;
  name: string;
  formula: string;
  unit: string;
  variables: string[];
};

type EventOverlayConfig = {
  enabled: boolean;
  paneScope: "all";
  signalId: string;
};

type SavedWorkspace = {
  axisConfigs: Record<string, AxisConfig>;
  derivedSignals: DerivedSignal[];
  eventOverlays: Record<string, EventOverlayConfig>;
  id: string;
  markers: Marker[];
  measurementCursors: MeasurementCursor[];
  name: string;
  createdAt: string;
  updatedAt: string;
  panes: Pane[];
  paneYRanges: Record<string, Partial<Record<AxisSide, ScaleRange>>>;
  preset: string;
  rangeMode: RangeMode;
  viewportDurationMs: number;
  panelWidths: {
    left: number;
    right: number;
  };
  customRange?: {
    start: string;
    end: string;
  };
  signalConfigs: Record<string, SignalViewConfig>;
};

type QueryStatus = {
  durationMs: number;
  maxPoints: number;
  uniqueQueries: number;
  visibleSeries: number;
};

const transparentDragImageSrc = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

type TooltipHostProps = {
  children: React.ReactNode;
  label: string;
  side?: "bottom" | "left" | "right" | "top";
};

function TooltipHost({ children, label, side = "bottom" }: TooltipHostProps) {
  return (
    <span className={`tooltip-host ${side}`}>
      {children}
      <span className="app-tooltip" role="tooltip">
        {label}
      </span>
    </span>
  );
}

type CollapsibleInspectorSectionProps = {
  children: React.ReactNode;
  collapsed: boolean;
  headerExtra?: React.ReactNode;
  icon: React.ReactNode;
  id: string;
  onToggle: (id: string) => void;
  title: string;
};

function CollapsibleInspectorSection({
  children,
  collapsed,
  headerExtra,
  icon,
  id,
  onToggle,
  title
}: CollapsibleInspectorSectionProps) {
  const toggle = React.useCallback(() => onToggle(id), [id, onToggle]);

  return (
    <section className={`inspector-section${collapsed ? " collapsed" : ""}`} data-testid={`inspector-section-${id}`}>
      <div
        aria-expanded={!collapsed}
        className="inspector-heading collapsible"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          toggle();
        }}
      >
        {icon}
        <span>{title}</span>
        <ChevronDown className="inspector-collapse-icon" size={14} />
        {headerExtra && (
          <span
            className="inspector-heading-extra"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {headerExtra}
          </span>
        )}
      </div>
      <div className="inspector-section-body" aria-hidden={collapsed}>
        <div className="inspector-section-content">{children}</div>
      </div>
    </section>
  );
}

type CollapsibleTreeSectionProps = {
  children: React.ReactNode;
  collapsed: boolean;
  id: string;
  onToggle: (id: string) => void;
  title: string;
};

function CollapsibleTreeSection({ children, collapsed, id, onToggle, title }: CollapsibleTreeSectionProps) {
  const toggle = React.useCallback(() => onToggle(id), [id, onToggle]);

  return (
    <div className={`left-collapsible-section${collapsed ? " collapsed" : ""}`}>
      <button
        aria-expanded={!collapsed}
        className="tree-heading collapsible"
        onClick={toggle}
        type="button"
      >
        <ChevronDown size={14} />
        {title}
      </button>
      <div className="left-collapsible-body" aria-hidden={collapsed}>
        <div className="left-collapsible-content">{children}</div>
      </div>
    </div>
  );
}

const palette = ["#4ade80", "#facc15", "#38bdf8", "#f472b6", "#fb923c", "#a78bfa"];
const liveRefreshMs = 15_000;
const autoWorkspaceKey = "influxVisualizer.workspace.v1";
const savedWorkspacesKey = "influxVisualizer.savedWorkspaces.v1";
const signalRowHeight = 31;
const signalListOverscan = 8;
const keyboardZoomInFactor = 0.8;
const keyboardZoomOutFactor = 1.25;
const keyboardPanFraction = 0.12;

function colorFor(index: number) {
  return palette[index % palette.length];
}

function formatValue(value: number | null | undefined, unit: string) {
  if (value === null || value === undefined) {
    return "--";
  }

  return `${value.toFixed(Math.abs(value) >= 100 ? 1 : 2)} ${unit}`;
}

function catalogUnitLabel(signal: Signal) {
  if (signal.kind === "state") {
    return "state";
  }

  const unit = signal.unit.trim();
  if (!unit || unit.length > 10 || /[._]/.test(unit)) {
    return "";
  }

  return unit;
}

function formatTime(timestamp: number | undefined) {
  if (!timestamp) {
    return "--";
  }

  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function timeRangeForPreset(preset: string) {
  const end = new Date();
  const start = new Date(end);

  if (preset === "1m") {
    start.setMinutes(end.getMinutes() - 1);
  } else if (preset === "30m") {
    start.setMinutes(end.getMinutes() - 30);
  } else if (preset === "1h") {
    start.setHours(end.getHours() - 1);
  } else if (preset === "6h") {
    start.setHours(end.getHours() - 6);
  } else if (preset === "7d") {
    start.setDate(end.getDate() - 7);
  } else {
    start.setDate(end.getDate() - 1);
  }

  return { start, end };
}

function durationMs(start: Date, end: Date) {
  return Math.max(end.getTime() - start.getTime(), 60_000);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function adaptiveMaxPoints(width: number, visiblePanes: number, rangeMs: number) {
  const hours = rangeMs / 3_600_000;
  const rangeFactor = hours <= 0.5 ? 3 : hours <= 6 ? 2.2 : hours <= 24 ? 1.55 : 1;
  const paneFactor = visiblePanes >= 12 ? 0.65 : visiblePanes >= 6 ? 0.8 : 1;
  const points = Math.round(Math.max(width, 420) * rangeFactor * paneFactor);
  return Math.min(Math.max(points, 300), 5000);
}

function toDateTimeLocalValue(date: Date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
}

function formatRangeDate(date: Date) {
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function lastValue(series?: QuerySeries) {
  if (!series) {
    return null;
  }

  for (let index = series.values.length - 1; index >= 0; index -= 1) {
    const value = series.values[index];
    if (value !== null) {
      return value;
    }
  }

  return null;
}

function nearestIndex(series: QuerySeries | undefined, timestamp: number | undefined) {
  if (!series || timestamp === undefined || series.time.length === 0) {
    return -1;
  }

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < series.time.length; index += 1) {
    const distance = Math.abs(series.time[index] - timestamp);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function valueLabel(signal: Signal, series: QuerySeries | undefined, timestamp?: number) {
  if (!series) {
    return "--";
  }

  const index = timestamp === undefined ? -1 : nearestIndex(series, timestamp);
  if (signal.kind === "state") {
    if (index >= 0) {
      return series.states?.[index] ?? "--";
    }

    for (let cursor = (series.states?.length ?? 0) - 1; cursor >= 0; cursor -= 1) {
      const state = series.states?.[cursor];
      if (state !== null && state !== undefined) {
        return state;
      }
    }
    return "--";
  }

  return formatValue(index >= 0 ? series.values[index] : lastValue(series), signal.unit);
}

function signalStats(signal: Signal, series: QuerySeries | undefined) {
  if (!series || series.time.length === 0) {
    return signal.kind === "state"
      ? { dominant: "--", latest: "--", transitions: 0 }
      : { latest: "--", max: "--", mean: "--", min: "--" };
  }

  if (signal.kind === "state") {
    const states = (series.states ?? []).filter((state): state is string => Boolean(state));
    const latest = states.at(-1) ?? "--";
    let transitions = 0;
    const durations = new Map<string, number>();

    for (let index = 0; index < states.length; index += 1) {
      if (index > 0 && states[index] !== states[index - 1]) {
        transitions += 1;
      }
      const duration = Math.max((series.time[index + 1] ?? series.time[index]) - series.time[index], 1);
      durations.set(states[index], (durations.get(states[index]) ?? 0) + duration);
    }

    const dominant = [...durations.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? latest;
    return { dominant, latest, transitions };
  }

  const values = series.values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) {
    return { latest: "--", max: "--", mean: "--", min: "--" };
  }

  const latest = values.at(-1);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;

  return {
    latest: formatValue(latest, signal.unit),
    max: formatValue(max, signal.unit),
    mean: formatValue(mean, signal.unit),
    min: formatValue(min, signal.unit)
  };
}

type FormulaToken =
  | { type: "number"; value: number }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: "+" | "-" | "*" | "/" | "(" | ")" };

type FormulaNode =
  | { type: "number"; value: number }
  | { type: "identifier"; value: string }
  | { type: "binary"; operator: "+" | "-" | "*" | "/"; left: FormulaNode; right: FormulaNode };

function tokenizeFormula(formula: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let index = 0;

  while (index < formula.length) {
    const char = formula[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[+\-*/()]/.test(char)) {
      tokens.push({ type: "operator", value: char as "+" | "-" | "*" | "/" | "(" | ")" });
      index += 1;
      continue;
    }

    const numberMatch = formula.slice(index).match(/^\d+(?:\.\d+)?/);
    if (numberMatch) {
      tokens.push({ type: "number", value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = formula.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (identifierMatch) {
      tokens.push({ type: "identifier", value: identifierMatch[0] });
      index += identifierMatch[0].length;
      continue;
    }

    throw new Error(`Unsupported formula token near "${formula.slice(index, index + 8)}"`);
  }

  return tokens;
}

function parseFormula(formula: string): FormulaNode {
  const tokens = tokenizeFormula(formula);
  let index = 0;

  const peek = () => tokens[index];
  const consume = () => tokens[index++];

  const parsePrimary = (): FormulaNode => {
    const token = consume();
    if (!token) {
      throw new Error("Unexpected end of formula");
    }

    if (token.type === "number") {
      return { type: "number", value: token.value };
    }

    if (token.type === "identifier") {
      return { type: "identifier", value: token.value };
    }

    if (token.type === "operator" && token.value === "(") {
      const node = parseAdditive();
      const close = consume();
      if (!close || close.type !== "operator" || close.value !== ")") {
        throw new Error("Missing closing parenthesis");
      }
      return node;
    }

    throw new Error("Unexpected formula token");
  };

  const parseMultiplicative = (): FormulaNode => {
    let node = parsePrimary();
    while (peek()?.type === "operator" && (peek().value === "*" || peek().value === "/")) {
      const operator = consume() as { type: "operator"; value: "*" | "/" };
      node = { type: "binary", operator: operator.value, left: node, right: parsePrimary() };
    }
    return node;
  };

  const parseAdditive = (): FormulaNode => {
    let node = parseMultiplicative();
    while (peek()?.type === "operator" && (peek().value === "+" || peek().value === "-")) {
      const operator = consume() as { type: "operator"; value: "+" | "-" };
      node = { type: "binary", operator: operator.value, left: node, right: parseMultiplicative() };
    }
    return node;
  };

  const parsed = parseAdditive();
  if (index < tokens.length) {
    throw new Error("Unexpected formula suffix");
  }
  return parsed;
}

function evaluateFormula(node: FormulaNode, values: Record<string, number | null | undefined>): number | null {
  if (node.type === "number") {
    return node.value;
  }

  if (node.type === "identifier") {
    const value = values[node.value];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  const left = evaluateFormula(node.left, values);
  const right = evaluateFormula(node.right, values);
  if (left === null || right === null) {
    return null;
  }

  if (node.operator === "+") {
    return left + right;
  }
  if (node.operator === "-") {
    return left - right;
  }
  if (node.operator === "*") {
    return left * right;
  }
  if (right === 0) {
    return null;
  }
  return left / right;
}

function valueAt(series: QuerySeries | undefined, timestamp: number | undefined) {
  const index = nearestIndex(series, timestamp);
  if (!series || index < 0) {
    return null;
  }
  return series.values[index];
}

function stateAt(series: QuerySeries | undefined, timestamp: number | undefined) {
  const index = nearestIndex(series, timestamp);
  if (!series || index < 0) {
    return "--";
  }
  return series.states?.[index] ?? "--";
}

function derivedSignalToSignal(signal: DerivedSignal): Signal {
  return {
    id: signal.id,
    measurement: "derived",
    entityId: signal.id.split("|")[1] ?? signal.id,
    fullName: `derived.${signal.name}`,
    domain: "derived",
    field: "value",
    kind: "numeric",
    name: signal.name,
    unit: signal.unit,
    group: "derived"
  };
}

function normalizeVariable(value: string) {
  return value.trim();
}

function resolveSignalToken(token: string, signalById: Map<string, Signal>) {
  const normalized = normalizeVariable(token);
  return [...signalById.values()].find(
    (signal) =>
      signal.id === normalized ||
      signal.entityId === normalized ||
      signal.fullName === normalized ||
      signal.name === normalized
  );
}

function computeDerivedSeries(
  derivedSignal: DerivedSignal,
  requestId: string,
  signalById: Map<string, Signal>,
  seriesMap: Record<string, QuerySeries>
): QuerySeries | null {
  const variableSignals = derivedSignal.variables
    .map((variable) => ({ variable, signal: resolveSignalToken(variable, signalById) }))
    .filter((entry): entry is { variable: string; signal: Signal } => Boolean(entry.signal));
  if (variableSignals.length === 0) {
    return null;
  }

  let parsedFormula: FormulaNode;
  try {
    parsedFormula = parseFormula(derivedSignal.formula);
  } catch {
    return null;
  }

  const primary = seriesMap[`__derived:${derivedSignal.id}:${variableSignals[0].signal.id}`];
  if (!primary) {
    return null;
  }

  const values = primary.time.map((timestamp) => {
    const variableValues: Record<string, number | null | undefined> = {};
    for (const { variable, signal } of variableSignals) {
      const sourceSeries = seriesMap[`__derived:${derivedSignal.id}:${signal.id}`];
      const sourceValue = valueAt(sourceSeries, timestamp);
      variableValues[variable] = sourceValue;
      variableValues[signal.entityId] = sourceValue;
      variableValues[signal.fullName] = sourceValue;
      variableValues[signal.name] = sourceValue;
    }
    return evaluateFormula(parsedFormula, variableValues);
  });

  return {
    requestId,
    signalId: derivedSignal.id,
    kind: "numeric",
    time: primary.time,
    values
  };
}

function markerExportPayload(markers: Marker[]) {
  return {
    version: 1,
    markers: markers.map((marker) => ({
      id: marker.id,
      timestamp: marker.timestamp,
      label: marker.label,
      color: marker.color
    }))
  };
}

function sanitizeImportedMarkers(value: unknown): Marker[] {
  const payload = value as { markers?: unknown[]; version?: number };
  const entries = Array.isArray(payload?.markers) ? payload.markers : [];
  const seen = new Set<string>();
  const markers: Marker[] = [];

  for (const entry of entries) {
    const marker = entry as Partial<Marker>;
    if (
      typeof marker.id !== "string" ||
      typeof marker.label !== "string" ||
      typeof marker.color !== "string" ||
      typeof marker.timestamp !== "number" ||
      !Number.isFinite(marker.timestamp)
    ) {
      continue;
    }

    const dedupeKey = `${marker.timestamp}:${marker.label}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    markers.push({
      id: marker.id,
      timestamp: marker.timestamp,
      label: marker.label,
      color: marker.color
    });
  }

  return markers;
}

function rangeFromValues(values: Array<number | null | undefined>): ScaleRange {
  const numericValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numericValues.length === 0) {
    return { max: 1, min: 0 };
  }

  const min = Math.min(...numericValues);
  const max = Math.max(...numericValues);
  if (min === max) {
    const padding = Math.max(Math.abs(max) * 0.1, 1);
    return { max: max + padding, min: min - padding };
  }

  return { max, min };
}

function zoomRange(range: ScaleRange, factor: number, anchor?: number): ScaleRange {
  const center = Number.isFinite(anchor) ? anchor! : (range.min + range.max) / 2;
  const nextMin = center - (center - range.min) * factor;
  const nextMax = center + (range.max - center) * factor;
  if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax) || nextMin === nextMax) {
    return range;
  }
  return {
    max: Math.max(nextMin, nextMax),
    min: Math.min(nextMin, nextMax)
  };
}

function panRange(range: ScaleRange, direction: 1 | -1): ScaleRange {
  const delta = (range.max - range.min) * keyboardPanFraction * direction;
  return {
    max: range.max + delta,
    min: range.min + delta
  };
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)
  );
}

function paneSignalKey(pane: Pane, side: AxisSide, signalIndex: number) {
  return `${pane.paneId}:${side}:${signalIndex}`;
}

function axisConfigKey(paneId: string, side: AxisSide) {
  return `${paneId}:${side}`;
}

function makePaneId() {
  return `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makePane(signalId: string, side: AxisSide): Pane {
  return {
    axes: {
      left: side === "left" ? [signalId] : [],
      right: side === "right" ? [signalId] : []
    },
    paneId: makePaneId()
  };
}

function axisUnit(pane: Pane, side: AxisSide, signalById: Map<string, Signal>) {
  const firstSignalId = pane.axes[side][0];
  return firstSignalId ? signalById.get(firstSignalId)?.unit : undefined;
}

function dropSideFromEvent(event: React.DragEvent<Element>): AxisSide {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientX - rect.left < rect.width / 2 ? "left" : "right";
}

function isPane(value: unknown): value is Pane {
  const pane = value as Pane;
  return (
    Boolean(pane) &&
    typeof pane.paneId === "string" &&
    Array.isArray(pane.axes?.left) &&
    Array.isArray(pane.axes?.right)
  );
}

function normalizeWorkspace(value: unknown, fallbackId?: string): SavedWorkspace | null {
  const parsed = value as Partial<SavedWorkspace>;
  if (!parsed || typeof parsed !== "object" || !parsed.name || !Array.isArray(parsed.panes)) {
    return null;
  }

  return {
    axisConfigs: parsed.axisConfigs ?? {},
    derivedSignals: Array.isArray(parsed.derivedSignals) ? parsed.derivedSignals : [],
    eventOverlays: parsed.eventOverlays ?? {},
    id: typeof parsed.id === "string" && parsed.id ? parsed.id : fallbackId ?? "workspace",
    markers: Array.isArray(parsed.markers) ? parsed.markers : [],
    measurementCursors: Array.isArray(parsed.measurementCursors)
      ? parsed.measurementCursors
      : [
          { id: "A", timestamp: null },
          { id: "B", timestamp: null }
        ],
    name: parsed.name,
    createdAt: parsed.createdAt ?? new Date().toISOString(),
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    panes: parsed.panes.filter(isPane),
    paneYRanges: parsed.paneYRanges ?? {},
    preset: parsed.preset ?? "24h",
    rangeMode: parsed.rangeMode === "custom" ? "custom" : "preset",
    viewportDurationMs: Math.max(Number(parsed.viewportDurationMs) || 86_400_000, 60_000),
    panelWidths: {
      left: clamp(Number(parsed.panelWidths?.left) || 306, 240, 640),
      right: clamp(Number(parsed.panelWidths?.right) || 280, 220, 420)
    },
    customRange: parsed.customRange,
    signalConfigs: parsed.signalConfigs ?? {}
  };
}

function readStoredWorkspace(key: string): SavedWorkspace | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? normalizeWorkspace(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function readSavedWorkspaces() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(savedWorkspacesKey) ?? "[]") as unknown[];
    return parsed
      .map((entry, index) => normalizeWorkspace(entry, `workspace-${index}`))
      .filter((workspace): workspace is SavedWorkspace => workspace !== null);
  } catch {
    return [];
  }
}

function writeSavedWorkspaces(workspaces: SavedWorkspace[]) {
  window.localStorage.setItem(savedWorkspacesKey, JSON.stringify(workspaces));
}

function sanitizeWorkspacePanes(panes: Pane[], signalById: Map<string, Signal>) {
  return panes
    .map((pane) => ({
      ...pane,
      axes: {
        left: pane.axes.left.filter((signalId) => signalById.has(signalId)),
        right: pane.axes.right.filter((signalId) => signalById.has(signalId))
      }
    }))
    .filter((pane) => pane.axes.left.length > 0 || pane.axes.right.length > 0);
}

function snapshotWorkspace(options: {
  axisConfigs: Record<string, AxisConfig>;
  customRange: TimeRange;
  derivedSignals: DerivedSignal[];
  eventOverlays: Record<string, EventOverlayConfig>;
  id: string;
  markers: Marker[];
  measurementCursors: MeasurementCursor[];
  name: string;
  paneYRanges: Record<string, Partial<Record<AxisSide, ScaleRange>>>;
  panes: Pane[];
  panelWidths: { left: number; right: number };
  preset: string;
  rangeMode: RangeMode;
  signalConfigs: Record<string, SignalViewConfig>;
  updatedAt?: string;
  viewport: TimeRange;
}) {
  const now = options.updatedAt ?? new Date().toISOString();
  return {
    id: options.id,
    name: options.name,
    createdAt: now,
    updatedAt: now,
    axisConfigs: options.axisConfigs,
    derivedSignals: options.derivedSignals,
    eventOverlays: options.eventOverlays,
    markers: options.markers,
    measurementCursors: options.measurementCursors,
    panes: options.panes,
    paneYRanges: options.paneYRanges,
    preset: options.preset,
    rangeMode: options.rangeMode,
    signalConfigs: options.signalConfigs,
    viewportDurationMs: durationMs(options.viewport.start, options.viewport.end),
    panelWidths: options.panelWidths,
    customRange:
      options.rangeMode === "custom"
        ? {
            start: options.customRange.start.toISOString(),
            end: options.customRange.end.toISOString()
          }
        : undefined
  } satisfies SavedWorkspace;
}

function App() {
  const initialViewport = React.useMemo(() => timeRangeForPreset("24h"), []);
  const chartSurfaceRef = React.useRef<HTMLElement | null>(null);
  const chartGridRef = React.useRef<HTMLDivElement | null>(null);
  const dragImageRef = React.useRef<HTMLImageElement | null>(null);
  const dragScrollFrameRef = React.useRef<number | null>(null);
  const dragScrollSpeedRef = React.useRef(0);
  const keyboardZoomHoldUntilRef = React.useRef(0);
  const keyboardZoomLeaveTimeoutRef = React.useRef<number | null>(null);
  const overviewRef = React.useRef<HTMLDivElement | null>(null);
  const overviewDragRef = React.useRef<OverviewDrag | null>(null);
  const markerImportRef = React.useRef<HTMLInputElement | null>(null);
  const resizeRef = React.useRef<PanelResize | null>(null);
  const restoredWorkspaceRef = React.useRef(false);
  const signalListRef = React.useRef<HTMLDivElement | null>(null);
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [configStatus, setConfigStatus] = React.useState<"checking" | "ok" | "error">("checking");
  const [configError, setConfigError] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [signals, setSignals] = React.useState<Signal[]>([]);
  const [knownSignals, setKnownSignals] = React.useState<Record<string, Signal>>({});
  const [signalsSource, setSignalsSource] = React.useState<"influx" | "fixture" | "error">("fixture");
  const [signalsLoading, setSignalsLoading] = React.useState(true);
  const [signalsError, setSignalsError] = React.useState("");
  const [signalListScrollTop, setSignalListScrollTop] = React.useState(0);
  const [signalListHeight, setSignalListHeight] = React.useState(0);
  const [panes, setPanes] = React.useState<Pane[]>([]);
  const [preset, setPreset] = React.useState("24h");
  const [viewport, setViewport] = React.useState(initialViewport);
  const [contextRange, setContextRange] = React.useState<TimeRange>(initialViewport);
  const [rangeMode, setRangeMode] = React.useState<RangeMode>("preset");
  const [liveMode, setLiveMode] = React.useState(false);
  const [seriesMap, setSeriesMap] = React.useState<Record<string, QuerySeries>>({});
  const [queryLoading, setQueryLoading] = React.useState(false);
  const [queryError, setQueryError] = React.useState("");
  const [queryDelayMs, setQueryDelayMs] = React.useState(0);
  const [queryStatus, setQueryStatus] = React.useState<QueryStatus>({
    durationMs: 0,
    maxPoints: 0,
    uniqueQueries: 0,
    visibleSeries: 0
  });
  const [chartSurfaceWidth, setChartSurfaceWidth] = React.useState(960);
  const [cursorTime, setCursorTime] = React.useState<number | undefined>();
  const [cursorHover, setCursorHover] = React.useState<CursorHover | null>(null);
  const [pointerInPanesArea, setPointerInPanesArea] = React.useState(false);
  const [hoveredPaneId, setHoveredPaneId] = React.useState<string | null>(null);
  const [lastPlotHover, setLastPlotHover] = React.useState<(PlotInteraction & { paneId: string }) | null>(null);
  const [keyboardZoomMode, setKeyboardZoomMode] = React.useState<KeyboardZoomMode>("none");
  const [selectedRequestId, setSelectedRequestId] = React.useState<string | null>(null);
  const [paneYRanges, setPaneYRanges] = React.useState<Record<string, Partial<Record<AxisSide, ScaleRange>>>>({});
  const [signalConfigs, setSignalConfigs] = React.useState<Record<string, SignalViewConfig>>({});
  const [axisConfigs, setAxisConfigs] = React.useState<Record<string, AxisConfig>>({});
  const [markers, setMarkers] = React.useState<Marker[]>([]);
  const [measurementCursors, setMeasurementCursors] = React.useState<MeasurementCursor[]>([
    { id: "A", timestamp: null },
    { id: "B", timestamp: null }
  ]);
  const [activeMeasurementCursor, setActiveMeasurementCursor] = React.useState<"A" | "B" | null>(null);
  const [derivedSignals, setDerivedSignals] = React.useState<DerivedSignal[]>([]);
  const [derivedName, setDerivedName] = React.useState("");
  const [derivedFormula, setDerivedFormula] = React.useState("");
  const [derivedUnit, setDerivedUnit] = React.useState("");
  const [derivedVariables, setDerivedVariables] = React.useState("");
  const [eventOverlays, setEventOverlays] = React.useState<Record<string, EventOverlayConfig>>({});
  const [markerMode, setMarkerMode] = React.useState(false);
  const [openSignalConfig, setOpenSignalConfig] = React.useState<string | null>(null);
  const [openAxisConfig, setOpenAxisConfig] = React.useState<{ paneId: string; side: AxisSide } | null>(null);
  const [interactionHelpOpen, setInteractionHelpOpen] = React.useState(false);
  const [rangeEditorOpen, setRangeEditorOpen] = React.useState(false);
  const [draftStart, setDraftStart] = React.useState(toDateTimeLocalValue(initialViewport.start));
  const [draftEnd, setDraftEnd] = React.useState(toDateTimeLocalValue(initialViewport.end));
  const [leftPanelWidth, setLeftPanelWidth] = React.useState(306);
  const [rightPanelWidth, setRightPanelWidth] = React.useState(280);
  const [paneDropTarget, setPaneDropTarget] = React.useState<PaneDropTarget>(null);
  const [reorderTarget, setReorderTarget] = React.useState<ReorderTarget>(null);
  const [signalInsertTarget, setSignalInsertTarget] = React.useState<SignalInsertTarget>(null);
  const [draggedSignalId, setDraggedSignalId] = React.useState<string | null>(null);
  const [dragPreviewPosition, setDragPreviewPosition] = React.useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = React.useState("");
  const [savedWorkspaces, setSavedWorkspaces] = React.useState<SavedWorkspace[]>(() => readSavedWorkspaces());
  const [workspaceName, setWorkspaceName] = React.useState("");
  const [collapsedLeftSections, setCollapsedLeftSections] = React.useState<Record<string, boolean>>({
    dataSource: true,
    derivedSignal: true,
    savedWorkspaces: true
  });
  const [collapsedInspectorSections, setCollapsedInspectorSections] = React.useState<Record<string, boolean>>({});
  const derivedCatalogSignals = React.useMemo(() => derivedSignals.map(derivedSignalToSignal), [derivedSignals]);
  const catalogSignals = React.useMemo(() => [...derivedCatalogSignals, ...signals], [derivedCatalogSignals, signals]);
  const signalById = React.useMemo(
    () => new Map([...Object.entries(knownSignals), ...derivedCatalogSignals.map((signal) => [signal.id, signal] as const)]),
    [derivedCatalogSignals, knownSignals]
  );
  const toggleInspectorSection = React.useCallback((sectionId: string) => {
    setCollapsedInspectorSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId]
    }));
  }, []);
  const toggleLeftSection = React.useCallback((sectionId: string) => {
    setCollapsedLeftSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId]
    }));
  }, []);

  const applyWorkspace = React.useCallback((workspace: SavedWorkspace) => {
    const nextDerivedSignals = Array.isArray(workspace.derivedSignals) ? workspace.derivedSignals : [];
    const workspaceSignalById = new Map(signalById);
    for (const signal of nextDerivedSignals.map(derivedSignalToSignal)) {
      workspaceSignalById.set(signal.id, signal);
    }
    const nextPanes = sanitizeWorkspacePanes(workspace.panes, workspaceSignalById);
    const keptPaneIds = new Set(nextPanes.map((pane) => pane.paneId));
    const keptRequestIds = new Set(
      nextPanes.flatMap((pane) =>
        (["left", "right"] as AxisSide[]).flatMap((side) =>
          pane.axes[side].map((_signalId, signalIndex) => paneSignalKey(pane, side, signalIndex))
        )
      )
    );
    const nextYRanges = Object.fromEntries(
      Object.entries(workspace.paneYRanges).filter(([paneId]) => keptPaneIds.has(paneId))
    ) as Record<string, Partial<Record<AxisSide, ScaleRange>>>;
    const nextSignalConfigs = Object.fromEntries(
      Object.entries(workspace.signalConfigs).filter(([requestId]) => keptRequestIds.has(requestId))
    );
    const nextAxisConfigs = Object.fromEntries(
      Object.entries(workspace.axisConfigs).filter(([key]) => {
        const [paneId, side] = key.split(":");
        return keptPaneIds.has(paneId) && (side === "left" || side === "right");
      })
    );
    const nextMarkers = workspace.markers.filter(
      (marker) =>
        typeof marker.id === "string" &&
        Number.isFinite(marker.timestamp) &&
        typeof marker.label === "string" &&
        typeof marker.color === "string"
    );
    const now = new Date();
    const duration = Math.max(workspace.viewportDurationMs, 60_000);
    const customStart = workspace.customRange?.start ? new Date(workspace.customRange.start) : null;
    const customEnd = workspace.customRange?.end ? new Date(workspace.customRange.end) : null;
    const useCustomRange = Boolean(
      workspace.rangeMode === "custom" &&
      customStart &&
      customEnd &&
      Number.isFinite(customStart.getTime()) &&
      Number.isFinite(customEnd.getTime()) &&
      customStart < customEnd
    );
    const nextRange = useCustomRange
      ? { start: customStart as Date, end: customEnd as Date }
      : { start: new Date(now.getTime() - duration), end: now };

    setPanes(nextPanes);
    setDerivedSignals(nextDerivedSignals);
    setEventOverlays(workspace.eventOverlays ?? {});
    setMeasurementCursors(workspace.measurementCursors ?? [{ id: "A", timestamp: null }, { id: "B", timestamp: null }]);
    setPaneYRanges(nextYRanges);
    setSignalConfigs(nextSignalConfigs);
    setAxisConfigs(nextAxisConfigs);
    setMarkers(nextMarkers);
    setPreset(workspace.preset);
    setRangeMode(workspace.rangeMode);
    setContextRange(nextRange);
    setViewport(nextRange);
    setLeftPanelWidth(workspace.panelWidths.left);
    setRightPanelWidth(workspace.panelWidths.right);
    setLiveMode(false);
    setMarkerMode(false);
    setActiveMeasurementCursor(null);
    setQueryDelayMs(0);
    setCursorTime(undefined);
    setCursorHover(null);
    setPointerInPanesArea(false);
    setHoveredPaneId(null);
    setLastPlotHover(null);
    setKeyboardZoomMode("none");
    setSelectedRequestId(null);
  }, [signalById]);

  React.useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  React.useEffect(() => {
    const signalList = signalListRef.current;
    if (!signalList) {
      return;
    }

    const updateHeight = () => setSignalListHeight(signalList.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(signalList);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const chartSurface = chartSurfaceRef.current;
    if (!chartSurface) {
      return;
    }

    const updateWidth = () => setChartSurfaceWidth(chartSurface.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(chartSurface);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    void fetchConfig()
      .then((nextConfig) => {
        if (!cancelled) {
          setConfig(nextConfig);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setConfigError(error.message);
        }
      });

    void testConfig()
      .then(() => {
        if (!cancelled) {
          setConfigStatus("ok");
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setConfigStatus("error");
          setConfigError(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setSignalsLoading(true);
      setSignalsError("");

      void fetchSignals({ search, limit: 1200 })
        .then((response) => {
          if (cancelled) {
            return;
          }

          setSignals(response.signals);
          setKnownSignals((current) => {
            const next = { ...current };
            for (const signal of response.signals) {
              next[signal.id] = signal;
            }
            return next;
          });
          setSignalsSource(response.source);
          setSignalsError(response.error ?? "");
        })
        .catch((error: Error) => {
          if (!cancelled) {
            setSignalsError(error.message);
            setSignalsSource("error");
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSignalsLoading(false);
          }
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [search]);

  React.useEffect(() => {
    if (restoredWorkspaceRef.current || signalById.size === 0 || signalsLoading) {
      return;
    }

    restoredWorkspaceRef.current = true;
    const workspace = readStoredWorkspace(autoWorkspaceKey);
    if (workspace) {
      applyWorkspace(workspace);
    }
  }, [applyWorkspace, signalById.size, signalsLoading]);

  React.useEffect(() => {
    if (!restoredWorkspaceRef.current) {
      return;
    }

    if (panes.length === 0) {
      window.localStorage.removeItem(autoWorkspaceKey);
      return;
    }

    const workspace = snapshotWorkspace({
      axisConfigs,
      derivedSignals,
      eventOverlays,
      id: "current",
      markers,
      measurementCursors,
      name: "Current workspace",
      panes,
      paneYRanges,
      preset,
      rangeMode,
      signalConfigs,
      viewport,
      customRange: contextRange,
      panelWidths: {
        left: leftPanelWidth,
        right: rightPanelWidth
      }
    });
    window.localStorage.setItem(autoWorkspaceKey, JSON.stringify(workspace));
  }, [
    axisConfigs,
    contextRange,
    derivedSignals,
    eventOverlays,
    leftPanelWidth,
    markers,
    measurementCursors,
    paneYRanges,
    panes,
    preset,
    rangeMode,
    rightPanelWidth,
    signalConfigs,
    viewport
  ]);

  const visiblePaneRequests = React.useMemo(
    () =>
      panes.flatMap((pane) =>
        (["left", "right"] as AxisSide[]).flatMap((side) =>
          pane.axes[side].map((signalId, signalIndex) => ({
            requestId: paneSignalKey(pane, side, signalIndex),
            signalId
          }))
        )
      ),
    [panes]
  );

  const derivedSourceRequests = React.useMemo(
    () => {
      const visibleDerivedIds = new Set(
        visiblePaneRequests
          .filter((request) => request.signalId.startsWith("derived|"))
          .map((request) => request.signalId)
      );
      return derivedSignals
        .filter((derivedSignal) => visibleDerivedIds.has(derivedSignal.id))
        .flatMap((derivedSignal) =>
          derivedSignal.variables
          .map((variable) => resolveSignalToken(variable, signalById))
            .filter((signal): signal is Signal => Boolean(signal))
            .filter((signal) => signal.kind === "numeric" && !signal.id.startsWith("derived|"))
          .map((signal) => ({
            requestId: `__derived:${derivedSignal.id}:${signal.id}`,
            signalId: signal.id
          }))
        );
    },
    [derivedSignals, signalById, visiblePaneRequests]
  );

  const queryRequests = React.useMemo(
    () => [
      ...visiblePaneRequests.filter((request) => !request.signalId.startsWith("derived|")),
      ...derivedSourceRequests
    ],
    [derivedSourceRequests, visiblePaneRequests]
  );

  const duplicateRequestMap = React.useMemo(() => {
    const groups = new Map<string, { canonical: string; requestIds: string[]; signalId: string }>();
    for (const request of queryRequests) {
      const group = groups.get(request.signalId);
      if (group) {
        group.requestIds.push(request.requestId);
      } else {
        groups.set(request.signalId, {
          canonical: request.requestId,
          requestIds: [request.requestId],
          signalId: request.signalId
        });
      }
    }
    return groups;
  }, [queryRequests]);

  const uniqueQueryRequests = React.useMemo(
    () =>
      [...duplicateRequestMap.values()].map((group) => ({
        requestId: group.canonical,
        signalId: group.signalId
      })),
    [duplicateRequestMap]
  );

  const queryMaxPoints = React.useMemo(
    () => adaptiveMaxPoints(chartSurfaceWidth, panes.length, durationMs(viewport.start, viewport.end)),
    [chartSurfaceWidth, panes.length, viewport.end, viewport.start]
  );

  React.useEffect(() => {
    if (queryRequests.length === 0) {
      setSeriesMap({});
      setQueryStatus({
        durationMs: 0,
        maxPoints: 0,
        uniqueQueries: 0,
        visibleSeries: 0
      });
      return;
    }

    const abortController = new AbortController();
    const timeout = window.setTimeout(() => {
      const queryStartedAt = performance.now();
      setQueryLoading(true);
      setQueryError("");
      void querySignals({
        signal: abortController.signal,
        signals: uniqueQueryRequests,
        start: viewport.start.toISOString(),
        end: viewport.end.toISOString(),
        maxPoints: queryMaxPoints
      })
        .then((response) => {
          if (abortController.signal.aborted) {
            return;
          }

          const canonicalSeries = new Map(response.series.map((series) => [series.requestId, series]));
          const nextSeriesMap: Record<string, QuerySeries> = {};
          for (const group of duplicateRequestMap.values()) {
            const series = canonicalSeries.get(group.canonical);
            if (!series) {
              continue;
            }
            for (const requestId of group.requestIds) {
              nextSeriesMap[requestId] = {
                ...series,
                requestId
              };
            }
          }

          for (const request of visiblePaneRequests) {
            if (!request.signalId.startsWith("derived|")) {
              continue;
            }
            const derivedSignal = derivedSignals.find((signal) => signal.id === request.signalId);
            if (!derivedSignal) {
              continue;
            }
            const derivedSeries = computeDerivedSeries(derivedSignal, request.requestId, signalById, nextSeriesMap);
            if (derivedSeries) {
              nextSeriesMap[request.requestId] = derivedSeries;
            }
          }

          setSeriesMap(nextSeriesMap);
          setQueryStatus({
            durationMs: Math.round(performance.now() - queryStartedAt),
            maxPoints: queryMaxPoints,
            uniqueQueries: uniqueQueryRequests.length,
            visibleSeries: visiblePaneRequests.length
          });
          setQueryError(response.error ?? "");
        })
        .catch((error: Error) => {
          if (!abortController.signal.aborted) {
            setQueryError(error.message);
            setSeriesMap({});
          }
        })
        .finally(() => {
          if (!abortController.signal.aborted) {
            setQueryLoading(false);
          }
        });
    }, queryDelayMs);

    return () => {
      abortController.abort();
      window.clearTimeout(timeout);
    };
  }, [
    derivedSignals,
    duplicateRequestMap,
    queryDelayMs,
    queryMaxPoints,
    queryRequests.length,
    signalById,
    uniqueQueryRequests,
    viewport,
    visiblePaneRequests
  ]);

  React.useEffect(() => {
    if (!liveMode || panes.length === 0) {
      return;
    }

    const interval = window.setInterval(() => {
      setQueryDelayMs(0);
      setContextRange((current) => {
        const width = durationMs(current.start, current.end);
        const end = new Date();
        return {
          start: new Date(end.getTime() - width),
          end
        };
      });
      setViewport((current) => {
        const width = durationMs(current.start, current.end);
        const end = new Date();
        return {
          start: new Date(end.getTime() - width),
          end
        };
      });
    }, liveRefreshMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [liveMode, panes.length]);

  const addPane = React.useCallback((signalId: string, side: AxisSide = "left") => {
    setQueryDelayMs(0);
    setPanes((current) => [...current, makePane(signalId, side)]);
  }, []);

  const addPaneAt = React.useCallback((signalId: string, index: number, side: AxisSide = "left") => {
    setQueryDelayMs(0);
    setPanes((current) => {
      const nextPane = makePane(signalId, side);
      const insertionIndex = clamp(index, 0, current.length);
      return [
        ...current.slice(0, insertionIndex),
        nextPane,
        ...current.slice(insertionIndex)
      ];
    });
  }, []);

  const addSignalToPane = React.useCallback((paneId: string, side: AxisSide, signalId: string) => {
    const incomingSignal = signalById.get(signalId);
    if (!incomingSignal) {
      return;
    }

    let added = false;
    setPanes((current) =>
      current.map((pane) => {
        if (pane.paneId !== paneId) {
          return pane;
        }

        const existingUnit = axisUnit(pane, side, signalById);
        if (existingUnit && existingUnit !== incomingSignal.unit) {
          setToast(`Cannot add ${incomingSignal.unit} to ${existingUnit} axis`);
          return pane;
        }

        added = true;
        return {
          ...pane,
          axes: {
            ...pane.axes,
            [side]: [...pane.axes[side], signalId]
          }
        };
      })
    );
    if (added) {
      setQueryDelayMs(0);
      setToast("");
    }
  }, [signalById]);

  const removePane = React.useCallback((paneId: string) => {
    setPanes((current) => current.filter((pane) => pane.paneId !== paneId));
    setPaneYRanges((current) => {
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setAxisConfigs((current) => {
      const next = { ...current };
      delete next[axisConfigKey(paneId, "left")];
      delete next[axisConfigKey(paneId, "right")];
      return next;
    });
    setSignalConfigs((current) =>
      Object.fromEntries(Object.entries(current).filter(([requestId]) => !requestId.startsWith(`${paneId}:`)))
    );
    setSelectedRequestId((current) => (current?.startsWith(`${paneId}:`) ? null : current));
  }, []);

  const removePaneSignal = React.useCallback((paneId: string, side: AxisSide, signalIndex: number) => {
    setPanes((current) =>
      current
        .map((pane) =>
          pane.paneId === paneId
            ? {
                ...pane,
                axes: {
                  ...pane.axes,
                  [side]: pane.axes[side].filter((_, index) => index !== signalIndex)
                }
              }
            : pane
        )
        .filter((pane) => pane.axes.left.length > 0 || pane.axes.right.length > 0)
    );
    setPaneYRanges((current) => {
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setSignalConfigs((current) =>
      Object.fromEntries(Object.entries(current).filter(([requestId]) => !requestId.startsWith(`${paneId}:`)))
    );
    setSelectedRequestId((current) => (current?.startsWith(`${paneId}:`) ? null : current));
  }, []);

  const resetToPreset = React.useCallback((nextPreset = preset) => {
    const range = rangeMode === "custom" ? contextRange : timeRangeForPreset(nextPreset);
    setContextRange(range);
    setViewport(range);
    setQueryDelayMs(0);
    setCursorTime(undefined);
    setCursorHover(null);
  }, [contextRange, preset, rangeMode]);

  const selectPreset = React.useCallback((nextPreset: string) => {
    const range = timeRangeForPreset(nextPreset);
    setPreset(nextPreset);
    setRangeMode("preset");
    setContextRange(range);
    setViewport(range);
    setQueryDelayMs(0);
    setCursorTime(undefined);
    setCursorHover(null);
  }, []);

  const clearWorkspace = React.useCallback(() => {
    setPanes([]);
    setPaneYRanges({});
    setSignalConfigs({});
    setAxisConfigs({});
    setMarkers([]);
    setMeasurementCursors([{ id: "A", timestamp: null }, { id: "B", timestamp: null }]);
    setActiveMeasurementCursor(null);
    setDerivedSignals([]);
    setEventOverlays({});
    setMarkerMode(false);
    setPointerInPanesArea(false);
    setHoveredPaneId(null);
    setLastPlotHover(null);
    setKeyboardZoomMode("none");
    setSelectedRequestId(null);
    setCursorTime(undefined);
    setCursorHover(null);
    window.localStorage.removeItem(autoWorkspaceKey);
  }, []);

  const saveNamedWorkspace = React.useCallback(() => {
    const trimmedName = workspaceName.trim();
    const name = trimmedName || `Workspace ${savedWorkspaces.length + 1}`;
    const workspace = snapshotWorkspace({
      axisConfigs,
      derivedSignals,
      eventOverlays,
      id: `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      markers,
      measurementCursors,
      name,
      panes,
      paneYRanges,
      preset,
      rangeMode,
      signalConfigs,
      viewport,
      customRange: contextRange,
      panelWidths: {
        left: leftPanelWidth,
        right: rightPanelWidth
      }
    });
    const nextWorkspaces = [workspace, ...savedWorkspaces].slice(0, 12);
    setSavedWorkspaces(nextWorkspaces);
    writeSavedWorkspaces(nextWorkspaces);
    setWorkspaceName("");
  }, [
    axisConfigs,
    contextRange,
    derivedSignals,
    eventOverlays,
    leftPanelWidth,
    markers,
    measurementCursors,
    paneYRanges,
    panes,
    preset,
    rangeMode,
    rightPanelWidth,
    savedWorkspaces,
    signalConfigs,
    viewport,
    workspaceName
  ]);

  const deleteSavedWorkspace = React.useCallback((workspaceId: string) => {
    setSavedWorkspaces((current) => {
      const nextWorkspaces = current.filter((workspace) => workspace.id !== workspaceId);
      writeSavedWorkspaces(nextWorkspaces);
      return nextWorkspaces;
    });
  }, []);

  const updateDragPreviewPosition = React.useCallback((event: React.DragEvent) => {
    if (!event.clientX && !event.clientY) {
      return;
    }

    setDragPreviewPosition({
      x: event.clientX,
      y: event.clientY
    });
  }, []);

  const stopDragAutoScroll = React.useCallback(() => {
    dragScrollSpeedRef.current = 0;
    if (dragScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(dragScrollFrameRef.current);
      dragScrollFrameRef.current = null;
    }
  }, []);

  const startDragAutoScroll = React.useCallback(() => {
    if (dragScrollFrameRef.current !== null) {
      return;
    }

    const tick = () => {
      const grid = chartGridRef.current;
      const speed = dragScrollSpeedRef.current;
      if (!grid || speed === 0) {
        dragScrollFrameRef.current = null;
        return;
      }

      grid.scrollTop += speed;
      dragScrollFrameRef.current = window.requestAnimationFrame(tick);
    };

    dragScrollFrameRef.current = window.requestAnimationFrame(tick);
  }, []);

  const updateDragAutoScroll = React.useCallback((event: React.DragEvent) => {
    const grid = chartGridRef.current;
    if (!grid || !draggedSignalId) {
      return;
    }

    const rect = grid.getBoundingClientRect();
    const edgeSize = Math.min(96, rect.height * 0.24);
    const distanceTop = event.clientY - rect.top;
    const distanceBottom = rect.bottom - event.clientY;
    let speed = 0;

    if (distanceTop < edgeSize) {
      speed = -Math.ceil(((edgeSize - Math.max(distanceTop, 0)) / edgeSize) * 14);
    } else if (distanceBottom < edgeSize) {
      speed = Math.ceil(((edgeSize - Math.max(distanceBottom, 0)) / edgeSize) * 14);
    }

    dragScrollSpeedRef.current = speed;
    if (speed !== 0) {
      startDragAutoScroll();
    } else {
      stopDragAutoScroll();
    }
  }, [draggedSignalId, startDragAutoScroll, stopDragAutoScroll]);

  const insertIndexFromGridPointer = React.useCallback((clientY: number) => {
    const grid = chartGridRef.current;
    if (!grid) {
      return panes.length;
    }

    const lanes = Array.from(grid.querySelectorAll<HTMLElement>("[data-testid='signal-lane']"));
    if (lanes.length === 0) {
      return 0;
    }

    for (let index = 0; index < lanes.length; index += 1) {
      const rect = lanes[index].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return index;
      }
    }

    return lanes.length;
  }, [panes.length]);

  const clearSignalDrag = React.useCallback(() => {
    setDraggedSignalId(null);
    setDragPreviewPosition(null);
    setPaneDropTarget(null);
    setSignalInsertTarget(null);
    stopDragAutoScroll();
  }, [stopDragAutoScroll]);

  const handleSignalDragStart = React.useCallback(
    (event: React.DragEvent, signalId: string) => {
      event.dataTransfer.setData("application/x-influx-signal", signalId);
      event.dataTransfer.effectAllowed = "copy";
      if (dragImageRef.current) {
        event.dataTransfer.setDragImage(dragImageRef.current, 0, 0);
      }
      setDraggedSignalId(signalId);
      updateDragPreviewPosition(event);
    },
    [updateDragPreviewPosition]
  );

  const handleDropToWorkspace = React.useCallback(
    (event: React.DragEvent) => {
      const signalId = event.dataTransfer.getData("application/x-influx-signal");
      if (!signalId) {
        return;
      }

      event.preventDefault();
      addPaneAt(signalId, signalInsertTarget?.index ?? insertIndexFromGridPointer(event.clientY), dropSideFromEvent(event));
      clearSignalDrag();
    },
    [addPaneAt, clearSignalDrag, insertIndexFromGridPointer, signalInsertTarget]
  );

  const applyTimeRange = React.useCallback(() => {
    const start = new Date(draftStart);
    const end = new Date(draftEnd);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      return;
    }

    const range = { start, end };
    setRangeMode("custom");
    setContextRange(range);
    setViewport(range);
    setLiveMode(false);
    setQueryDelayMs(0);
    setCursorTime(undefined);
    setCursorHover(null);
    setRangeEditorOpen(false);
  }, [draftEnd, draftStart]);

  const openRangeEditor = React.useCallback(() => {
    setDraftStart(toDateTimeLocalValue(viewport.start));
    setDraftEnd(toDateTimeLocalValue(viewport.end));
    setInteractionHelpOpen(false);
    setOpenAxisConfig(null);
    setOpenSignalConfig(null);
    setRangeEditorOpen((open) => !open);
  }, [viewport.end, viewport.start]);

  const cancelKeyboardZoomLeaveClear = React.useCallback(() => {
    if (keyboardZoomLeaveTimeoutRef.current !== null) {
      window.clearTimeout(keyboardZoomLeaveTimeoutRef.current);
      keyboardZoomLeaveTimeoutRef.current = null;
    }
  }, []);

  const clearKeyboardInteraction = React.useCallback(() => {
    cancelKeyboardZoomLeaveClear();
    keyboardZoomHoldUntilRef.current = 0;
    setPointerInPanesArea(false);
    setHoveredPaneId(null);
    setLastPlotHover(null);
    setKeyboardZoomMode("none");
  }, [cancelKeyboardZoomLeaveClear]);

  const armKeyboardZoomHold = React.useCallback((durationMs = 900) => {
    keyboardZoomHoldUntilRef.current = Date.now() + durationMs;
  }, []);

  const handlePanesAreaEnter = React.useCallback(() => {
    cancelKeyboardZoomLeaveClear();
    setPointerInPanesArea(true);
  }, [cancelKeyboardZoomLeaveClear]);

  const handlePanesAreaLeave = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    clearKeyboardInteraction();
  }, [clearKeyboardInteraction]);

  const clearCursor = React.useCallback(() => {
    setCursorHover(null);
    setCursorTime(undefined);
  }, []);

  const updatePaneYRange = React.useCallback((paneId: string, ranges: Partial<Record<AxisSide, ScaleRange>>) => {
    setPaneYRanges((current) => ({
      ...current,
      [paneId]: {
        ...current[paneId],
        ...ranges
      }
    }));
    setAxisConfigs((current) => {
      const next = { ...current };
      for (const [side, range] of Object.entries(ranges) as [AxisSide, ScaleRange][]) {
        if (!range) {
          continue;
        }
        next[axisConfigKey(paneId, side)] = {
          ...next[axisConfigKey(paneId, side)],
          max: range.max,
          min: range.min,
          mode: "manual"
        };
      }
      return next;
    });
  }, []);

  const resetPaneAndViewport = React.useCallback((paneId: string) => {
    setPaneYRanges((current) => {
      const next = { ...current };
      delete next[paneId];
      return next;
    });
    setAxisConfigs((current) => {
      const next = { ...current };
      delete next[axisConfigKey(paneId, "left")];
      delete next[axisConfigKey(paneId, "right")];
      return next;
    });
    resetToPreset();
  }, [resetToPreset]);

  const updateViewportFromSelection = React.useCallback((start: Date, end: Date) => {
    setLiveMode(false);
    setQueryDelayMs(250);
    setViewport({ start, end });
    setCursorTime(undefined);
    setCursorHover(null);
  }, []);

  const requestContext = React.useCallback((requestId: string | null) => {
    if (!requestId) {
      return null;
    }

    for (const pane of panes) {
      for (const side of ["left", "right"] as AxisSide[]) {
        const signalIndex = pane.axes[side].findIndex(
          (_signalId, index) => paneSignalKey(pane, side, index) === requestId
        );
        if (signalIndex >= 0) {
          const signalId = pane.axes[side][signalIndex];
          const signal = signalById.get(signalId);
          return signal
            ? {
                pane,
                requestId,
                series: seriesMap[requestId],
                side,
                signal,
                signalId,
                signalIndex
              }
            : null;
        }
      }
    }

    return null;
  }, [panes, seriesMap, signalById]);

  const paneSideRange = React.useCallback((paneId: string, side: AxisSide): ScaleRange => {
    const axisConfig = axisConfigs[axisConfigKey(paneId, side)];
    const manualMin = axisConfig?.min;
    const manualMax = axisConfig?.max;
    if (
      axisConfig?.mode === "manual" &&
      Number.isFinite(manualMin) &&
      Number.isFinite(manualMax) &&
      manualMin !== manualMax
    ) {
      return { max: manualMax as number, min: manualMin as number };
    }

    const currentRange = paneYRanges[paneId]?.[side];
    if (currentRange) {
      return currentRange;
    }

    const pane = panes.find((nextPane) => nextPane.paneId === paneId);
    if (!pane) {
      return { max: 1, min: 0 };
    }

    const values = pane.axes[side].flatMap((signalId, signalIndex) => {
      const requestId = paneSignalKey(pane, side, signalIndex);
      return seriesMap[requestId]?.values ?? [];
    });
    return rangeFromValues(values);
  }, [axisConfigs, paneYRanges, panes, seriesMap]);

  const activeKeyboardTarget = React.useCallback(() => {
    if (!hoveredPaneId) {
      return null;
    }

    const selectedContext = requestContext(selectedRequestId);
    if (selectedContext?.pane.paneId === hoveredPaneId) {
      return selectedContext;
    }

    if (lastPlotHover?.paneId === hoveredPaneId) {
      return requestContext(lastPlotHover.requestId);
    }

    const pane = panes.find((nextPane) => nextPane.paneId === hoveredPaneId);
    if (!pane) {
      return null;
    }

    const side: AxisSide = pane.axes.left.length > 0 ? "left" : "right";
    const signalId = pane.axes[side][0];
    const signal = signalById.get(signalId);
    if (!signal) {
      return null;
    }

    const requestId = paneSignalKey(pane, side, 0);
    return {
      pane,
      requestId,
      series: seriesMap[requestId],
      side,
      signal,
      signalId,
      signalIndex: 0
    };
  }, [hoveredPaneId, lastPlotHover, panes, requestContext, selectedRequestId, seriesMap, signalById]);

  const setViewportAround = React.useCallback((centerMs: number, widthMs: number) => {
    const safeWidth = Math.max(widthMs, 60_000);
    const start = new Date(centerMs - safeWidth / 2);
    const end = new Date(centerMs + safeWidth / 2);
    setLiveMode(false);
    setQueryDelayMs(120);
    setViewport({ start, end });
    setContextRange((current) => ({
      start: new Date(Math.min(current.start.getTime(), start.getTime())),
      end: new Date(Math.max(current.end.getTime(), end.getTime()))
    }));
    setCursorTime(undefined);
    setCursorHover(null);
  }, []);

  const panViewport = React.useCallback((direction: 1 | -1) => {
    const width = durationMs(viewport.start, viewport.end);
    const delta = width * keyboardPanFraction * direction;
    setViewportAround((viewport.start.getTime() + viewport.end.getTime()) / 2 + delta, width);
  }, [setViewportAround, viewport.end, viewport.start]);

  const zoomViewport = React.useCallback((factor: number) => {
    const width = durationMs(viewport.start, viewport.end);
    const centerMs = lastPlotHover?.time ? lastPlotHover.time * 1000 : (viewport.start.getTime() + viewport.end.getTime()) / 2;
    setViewportAround(centerMs, width * factor);
  }, [lastPlotHover, setViewportAround, viewport.end, viewport.start]);

  const applyKeyboardYRange = React.useCallback((operation: "panDown" | "panUp" | "zoomIn" | "zoomOut") => {
    const target = activeKeyboardTarget();
    if (!target) {
      return;
    }

    const range = paneSideRange(target.pane.paneId, target.side);
    const pointerAnchor =
      lastPlotHover?.paneId === target.pane.paneId &&
      lastPlotHover.side === target.side &&
      Number.isFinite(lastPlotHover.axisValue)
        ? lastPlotHover.axisValue
        : undefined;
    const nextRange =
      operation === "panUp"
        ? panRange(range, 1)
        : operation === "panDown"
          ? panRange(range, -1)
          : zoomRange(range, operation === "zoomIn" ? keyboardZoomInFactor : keyboardZoomOutFactor, pointerAnchor);

    updatePaneYRange(target.pane.paneId, { [target.side]: nextRange });
  }, [activeKeyboardTarget, lastPlotHover, paneSideRange, updatePaneYRange]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setInteractionHelpOpen(false);
        setOpenAxisConfig(null);
        setOpenSignalConfig(null);
        setRangeEditorOpen(false);
        return;
      }

      if (isEditableKeyboardTarget(event.target) || (!pointerInPanesArea && !hoveredPaneId)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "x" || key === "y" || key === "z") {
        event.preventDefault();
        armKeyboardZoomHold();
        setKeyboardZoomMode(key === "z" ? "xy" : key);
        return;
      }

      if (key === "a" || key === "b") {
        event.preventDefault();
        setMarkerMode(false);
        setActiveMeasurementCursor(key === "a" ? "A" : "B");
        return;
      }

      if (key === "m") {
        event.preventDefault();
        setMarkerMode((active) => !active);
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        panViewport(event.key === "ArrowRight" ? 1 : -1);
        return;
      }

      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        applyKeyboardYRange(event.key === "ArrowUp" ? "panUp" : "panDown");
        return;
      }

      if ((key === "e" || key === "d") && keyboardZoomMode !== "none") {
        event.preventDefault();
        armKeyboardZoomHold();
        const factor = key === "e" ? keyboardZoomInFactor : keyboardZoomOutFactor;
        if (keyboardZoomMode === "x" || keyboardZoomMode === "xy") {
          zoomViewport(factor);
        }
        if (keyboardZoomMode === "y" || keyboardZoomMode === "xy") {
          applyKeyboardYRange(key === "e" ? "zoomIn" : "zoomOut");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    applyKeyboardYRange,
    armKeyboardZoomHold,
    hoveredPaneId,
    keyboardZoomMode,
    panViewport,
    pointerInPanesArea,
    zoomViewport
  ]);

  const updateSignalConfig = React.useCallback((requestId: string, nextConfig: Partial<SignalViewConfig>) => {
    setSignalConfigs((current) => ({
      ...current,
      [requestId]: {
        ...current[requestId],
        ...nextConfig
      }
    }));
  }, []);

  const updateAxisConfig = React.useCallback((paneId: string, side: AxisSide, nextConfig: Partial<AxisConfig>) => {
    setAxisConfigs((current) => {
      const key = axisConfigKey(paneId, side);
      const currentConfig = current[key] ?? { mode: "auto" };
      return {
        ...current,
        [key]: {
          ...currentConfig,
          ...nextConfig
        }
      };
    });
  }, []);

  const resetAxisConfig = React.useCallback((paneId: string, side: AxisSide) => {
    setAxisConfigs((current) => {
      const next = { ...current };
      delete next[axisConfigKey(paneId, side)];
      return next;
    });
    setPaneYRanges((current) => ({
      ...current,
      [paneId]: {
        ...current[paneId],
        [side]: undefined
      }
    }));
  }, []);

  const addDerivedSignal = React.useCallback(() => {
    const name = derivedName.trim() || `Derived ${derivedSignals.length + 1}`;
    const formula = derivedFormula.trim();
    const variables = derivedVariables
      .split(",")
      .map(normalizeVariable)
      .filter(Boolean);
    if (!formula || variables.length === 0) {
      setToast("Add a formula and at least one variable");
      return;
    }

    try {
      parseFormula(formula);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Invalid formula");
      return;
    }

    const unresolvedVariable = variables.find((variable) => !resolveSignalToken(variable, signalById));
    if (unresolvedVariable) {
      setToast(`Unknown variable ${unresolvedVariable}`);
      return;
    }

    const id = `derived|${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}|value`;
    setDerivedSignals((current) => [
      ...current,
      {
        id,
        name,
        formula,
        unit: derivedUnit.trim(),
        variables
      }
    ]);
    setDerivedName("");
    setDerivedFormula("");
    setDerivedUnit("");
    setDerivedVariables("");
    setToast("");
  }, [derivedFormula, derivedName, derivedSignals.length, derivedUnit, derivedVariables, signalById]);

  const deleteDerivedSignal = React.useCallback((signalId: string) => {
    const affectedPaneIds = new Set(
      panes
        .filter((pane) => pane.axes.left.includes(signalId) || pane.axes.right.includes(signalId))
        .map((pane) => pane.paneId)
    );

    setDerivedSignals((current) => current.filter((signal) => signal.id !== signalId));
    setPanes((current) =>
      current
        .map((pane) => ({
          ...pane,
          axes: {
            left: pane.axes.left.filter((paneSignalId) => paneSignalId !== signalId),
            right: pane.axes.right.filter((paneSignalId) => paneSignalId !== signalId)
          }
        }))
        .filter((pane) => pane.axes.left.length > 0 || pane.axes.right.length > 0)
    );
    setPaneYRanges((current) =>
      Object.fromEntries(Object.entries(current).filter(([paneId]) => !affectedPaneIds.has(paneId)))
    );
    setSignalConfigs((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([requestId]) => {
          const [paneId] = requestId.split(":");
          return !affectedPaneIds.has(paneId);
        })
      )
    );
    setEventOverlays((current) => {
      const next = { ...current };
      delete next[signalId];
      return next;
    });
    setSelectedRequestId((current) => {
      if (!current) {
        return current;
      }
      const [paneId] = current.split(":");
      return affectedPaneIds.has(paneId) ? null : current;
    });
    setQueryDelayMs(0);
    setToast("");
  }, [panes]);

  const toggleEventOverlay = React.useCallback((signalId: string, enabled: boolean) => {
    setEventOverlays((current) => ({
      ...current,
      [signalId]: {
        enabled,
        paneScope: "all",
        signalId
      }
    }));
  }, []);

  const setMeasurementCursor = React.useCallback((cursorId: "A" | "B", timestamp: number) => {
    setMeasurementCursors((current) =>
      current.map((cursor) => (cursor.id === cursorId ? { ...cursor, timestamp } : cursor))
    );
    setActiveMeasurementCursor(null);
  }, []);

  const clearMeasurementCursors = React.useCallback(() => {
    setMeasurementCursors([{ id: "A", timestamp: null }, { id: "B", timestamp: null }]);
    setActiveMeasurementCursor(null);
  }, []);

  const addMarker = React.useCallback((timestamp: number) => {
    setMarkers((current) => [
      ...current,
      {
        color: colorFor(current.length + 3),
        id: `marker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        label: `M${current.length + 1}`,
        timestamp
      }
    ]);
    setMarkerMode(false);
  }, []);

  const updateMarker = React.useCallback((markerId: string, nextMarker: Partial<Marker>) => {
    setMarkers((current) =>
      current.map((marker) => (marker.id === markerId ? { ...marker, ...nextMarker } : marker))
    );
  }, []);

  const deleteMarker = React.useCallback((markerId: string) => {
    setMarkers((current) => current.filter((marker) => marker.id !== markerId));
  }, []);

  const exportMarkers = React.useCallback(() => {
    const blob = new Blob([JSON.stringify(markerExportPayload(markers), null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "homescope-markers.json";
    link.click();
    URL.revokeObjectURL(url);
  }, [markers]);

  const importMarkers = React.useCallback((file: File | null | undefined) => {
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const importedMarkers = sanitizeImportedMarkers(JSON.parse(String(reader.result ?? "{}")));
        setMarkers((current) => {
          const existing = new Set(current.map((marker) => `${marker.timestamp}:${marker.label}`));
          const nextImported = importedMarkers.filter((marker) => !existing.has(`${marker.timestamp}:${marker.label}`));
          return [...current, ...nextImported];
        });
        setToast(importedMarkers.length ? `Imported ${importedMarkers.length} markers` : "No valid markers found");
      } catch {
        setToast("Invalid marker import file");
      }
    };
    reader.readAsText(file);
  }, []);

  const contextStartMs = contextRange.start.getTime();
  const contextEndMs = contextRange.end.getTime();
  const contextDurationMs = Math.max(contextEndMs - contextStartMs, 1);
  const viewportDurationMs = durationMs(viewport.start, viewport.end);
  const overviewLeftPct = clamp(
    ((viewport.start.getTime() - contextStartMs) / contextDurationMs) * 100,
    0,
    100
  );
  const overviewWidthPct = clamp((viewportDurationMs / contextDurationMs) * 100, 0, 100 - overviewLeftPct);

  const scrubViewport = React.useCallback((nextStartMs: number, widthMs: number) => {
    const maxStart = contextEndMs - widthMs;
    const startMs = clamp(nextStartMs, contextStartMs, Math.max(contextStartMs, maxStart));
    setLiveMode(false);
    setQueryDelayMs(120);
    setCursorTime(undefined);
    setCursorHover(null);
    setViewport({
      start: new Date(startMs),
      end: new Date(startMs + widthMs)
    });
  }, [contextEndMs, contextStartMs]);

  const recenterViewport = React.useCallback((clientX: number) => {
    const track = overviewRef.current;
    if (!track) {
      return;
    }

    const rect = track.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    const centerMs = contextStartMs + ratio * contextDurationMs;
    scrubViewport(centerMs - viewportDurationMs / 2, viewportDurationMs);
  }, [contextDurationMs, contextStartMs, scrubViewport, viewportDurationMs]);

  const startOverviewDrag = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    overviewDragRef.current = {
      durationMs: viewportDurationMs,
      pointerId: event.pointerId,
      startMs: viewport.start.getTime(),
      x: event.clientX
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [viewport.start, viewportDurationMs]);

  const moveOverviewDrag = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = overviewDragRef.current;
    const track = overviewRef.current;
    if (!drag || !track) {
      return;
    }

    const rect = track.getBoundingClientRect();
    const deltaMs = ((event.clientX - drag.x) / rect.width) * contextDurationMs;
    scrubViewport(drag.startMs + deltaMs, drag.durationMs);
  }, [contextDurationMs, scrubViewport]);

  const stopOverviewDrag = React.useCallback(() => {
    overviewDragRef.current = null;
  }, []);

  const movePane = React.useCallback((sourcePaneId: string, targetPaneId: string, position: "before" | "after") => {
    if (sourcePaneId === targetPaneId) {
      return;
    }

    setPanes((current) => {
      const source = current.find((pane) => pane.paneId === sourcePaneId);
      if (!source) {
        return current;
      }

      const withoutSource = current.filter((pane) => pane.paneId !== sourcePaneId);
      const targetIndex = withoutSource.findIndex((pane) => pane.paneId === targetPaneId);
      if (targetIndex < 0) {
        return current;
      }

      const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
      return [
        ...withoutSource.slice(0, insertIndex),
        source,
        ...withoutSource.slice(insertIndex)
      ];
    });
  }, []);

  const startPanelResize = React.useCallback(
    (side: "left" | "right", event: React.PointerEvent<HTMLButtonElement>) => {
      resizeRef.current = {
        initialLeftWidth: leftPanelWidth,
        initialRightWidth: rightPanelWidth,
        side,
        startX: event.clientX
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [leftPanelWidth, rightPanelWidth]
  );

  const movePanelResize = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize) {
      return;
    }

    const delta = event.clientX - resize.startX;
    if (resize.side === "left") {
      setLeftPanelWidth(clamp(resize.initialLeftWidth + delta, 240, 640));
      return;
    }

    setRightPanelWidth(clamp(resize.initialRightWidth - delta, 220, 420));
  }, []);

  const stopPanelResize = React.useCallback(() => {
    resizeRef.current = null;
  }, []);

  const visibleStartLabel = formatRangeDate(viewport.start);
  const visibleEndLabel = formatRangeDate(viewport.end);
  const rangeLabel = rangeMode === "custom" ? "Custom" : preset;
  const configConfigured = Boolean(config?.configured);
  const sourceTitle = configConfigured ? "Home InfluxDB" : "Setup Required";
  const sourceDetail = configConfigured
    ? `${config?.database ?? ""} / ${config?.connectionLabel ?? "configured"}`
    : config?.error ?? "Add InfluxDB credentials in the add-on options.";
  const showSetupAlert = Boolean(config && !configConfigured);
  const showConnectionAlert = configConfigured && configStatus === "error";
  const readoutUsesCursor = cursorHover !== null && cursorTime !== undefined;
  const liveReadout = !readoutUsesCursor && liveMode;
  const selectedContext = requestContext(selectedRequestId);
  const selectedStats = selectedContext ? signalStats(selectedContext.signal, selectedContext.series) : null;
  const selectedSignalLabel = selectedContext ? selectedContext.signal.fullName : "None";
  const cursorA = measurementCursors.find((cursor) => cursor.id === "A")?.timestamp ?? null;
  const cursorB = measurementCursors.find((cursor) => cursor.id === "B")?.timestamp ?? null;
  const selectedAValue = selectedContext?.signal.kind === "state"
    ? stateAt(selectedContext.series, cursorA ?? undefined)
    : formatValue(valueAt(selectedContext?.series, cursorA ?? undefined), selectedContext?.signal.unit ?? "");
  const selectedBValue = selectedContext?.signal.kind === "state"
    ? stateAt(selectedContext.series, cursorB ?? undefined)
    : formatValue(valueAt(selectedContext?.series, cursorB ?? undefined), selectedContext?.signal.unit ?? "");
  const selectedDeltaValue =
    selectedContext?.signal.kind === "state"
      ? selectedAValue !== "--" && selectedBValue !== "--" && selectedAValue !== selectedBValue
        ? "Changed"
        : selectedAValue !== "--" && selectedBValue !== "--"
          ? "Same"
          : "--"
      : formatValue(
          typeof valueAt(selectedContext?.series, cursorA ?? undefined) === "number" &&
            typeof valueAt(selectedContext?.series, cursorB ?? undefined) === "number"
            ? (valueAt(selectedContext?.series, cursorB ?? undefined) as number) -
                (valueAt(selectedContext?.series, cursorA ?? undefined) as number)
            : null,
          selectedContext?.signal.unit ?? ""
        );
  const eventOverlayMarkers: EventOverlay[] = React.useMemo(() => {
    const overlays: EventOverlay[] = [];
    const seen = new Set<string>();
    for (const pane of panes) {
      for (const side of ["left", "right"] as AxisSide[]) {
        pane.axes[side].forEach((signalId, signalIndex) => {
          const signal = signalById.get(signalId);
          const overlayConfig = eventOverlays[signalId];
          if (!signal || signal.kind !== "state" || !overlayConfig?.enabled) {
            return;
          }

          const requestId = paneSignalKey(pane, side, signalIndex);
          const series = seriesMap[requestId];
          const states = series?.states ?? [];
          for (let index = 1; index < states.length; index += 1) {
            if (!states[index] || states[index] === states[index - 1]) {
              continue;
            }

            const timestamp = series?.time[index];
            if (!timestamp) {
              continue;
            }
            const key = `${signalId}:${timestamp}:${states[index]}`;
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            overlays.push({
              id: key,
              color: "#93c5fd",
              label: `${signal.name}: ${states[index]}`,
              timestamp
            });
          }
        });
      }
    }
    return overlays.slice(0, 80);
  }, [eventOverlays, panes, seriesMap, signalById]);
  const keyboardZoomLabel = keyboardZoomMode === "none" ? "Off" : keyboardZoomMode.toUpperCase();
  const panesShortcutState = pointerInPanesArea ? "Active in panes" : "Inactive";
  const interactionHelpItems = [
    ["Arrows", "Pan time left/right or the hovered axis up/down"],
    ["X / Y / Z", "Set keyboard zoom to X, Y, or XY"],
    ["E / D", "Zoom in or out around the mouse target"],
    ["A / B", "Place measurement cursor A or B at the next chart click"],
    ["M", "Toggle marker placement while the mouse is over panes"],
    ["Ctrl-click", "Place a marker immediately at the clicked timestamp"],
    ["Double-click", "Reset the pane axis and active time range"],
    ["Drag", "Select horizontal, vertical, or diagonal zoom regions"]
  ];
  const virtualCatalogHeight = catalogSignals.length * signalRowHeight;
  const virtualCatalogStart = clamp(
    Math.floor(signalListScrollTop / signalRowHeight) - signalListOverscan,
    0,
    Math.max(catalogSignals.length - 1, 0)
  );
  const virtualCatalogCount = Math.ceil((signalListHeight || 480) / signalRowHeight) + signalListOverscan * 2;
  const virtualCatalogSignals = catalogSignals.slice(virtualCatalogStart, virtualCatalogStart + virtualCatalogCount);
  const draggedSignal = draggedSignalId ? signalById.get(draggedSignalId) : undefined;
  const draggedSignalIndex = draggedSignal ? Math.max(catalogSignals.findIndex((signal) => signal.id === draggedSignal.id), 0) : 0;
  const draggedSignalUnit = draggedSignal ? catalogUnitLabel(draggedSignal) : "";

  return (
    <main
      className={`app-shell${draggedSignalId ? " signal-dragging" : ""}`}
      onDragEnd={clearSignalDrag}
      onDragOver={updateDragPreviewPosition}
      style={{ gridTemplateColumns: `${leftPanelWidth}px minmax(420px, 1fr)` }}
    >
      <aside className="signal-panel" style={{ width: leftPanelWidth }}>
        <button
          aria-label="Resize signal catalog"
          className="panel-resize-handle left"
          onPointerCancel={stopPanelResize}
          onPointerDown={(event) => startPanelResize("left", event)}
          onPointerMove={movePanelResize}
          onPointerUp={stopPanelResize}
          title="Resize signal catalog"
        />
        <div className="panel-title">
          <FolderTree size={18} />
          <span>Signal Catalog</span>
        </div>

        <div className="source-card">
          <div>
            <strong>{sourceTitle}</strong>
            <span>{sourceDetail}</span>
          </div>
          <span className={configConfigured && configStatus === "ok" ? "status-dot" : "status-dot error"} />
        </div>

        {showSetupAlert && (
          <div className="inline-alert">
            Fixture data is shown until the InfluxDB add-on options are complete. Password values stay on the server.
          </div>
        )}

        {showConnectionAlert && (
          <div className="inline-alert">Connection check failed: {configError}</div>
        )}

        <label className="search-box">
          <Search size={16} />
          <input
            placeholder="Search entity, unit, state"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <div className="tree-section">
          <CollapsibleTreeSection
            collapsed={Boolean(collapsedLeftSections.allSignals)}
            id="allSignals"
            onToggle={toggleLeftSection}
            title={signalsSource === "influx" ? "All Signals" : "Fixture Signals"}
          >
            <div
              className="signal-list"
              onScroll={(event) => setSignalListScrollTop(event.currentTarget.scrollTop)}
              ref={signalListRef}
            >
              {signalsLoading && <div className="list-state">Loading signal catalog...</div>}
              {!signalsLoading && catalogSignals.length === 0 && (
                <div className="list-state">No matching signals found.</div>
              )}
              {!signalsLoading && catalogSignals.length > 0 && (
                <div className="virtual-signal-list" style={{ height: virtualCatalogHeight }}>
                  {virtualCatalogSignals.map((signal, visibleIndex) => {
                    const index = virtualCatalogStart + visibleIndex;
                    return (
                      <button
                        className={`signal-row${draggedSignalId === signal.id ? " dragging" : ""}`}
                        data-testid={`signal-row-${signal.id}`}
                        draggable
                        key={signal.id}
                        aria-label={`Add signal ${signal.fullName}`}
                        onClick={() => addPane(signal.id)}
                        onDrag={updateDragPreviewPosition}
                        onDragEnd={clearSignalDrag}
                        onDragStart={(event) => handleSignalDragStart(event, signal.id)}
                        style={{
                          transform: `translateY(${index * signalRowHeight}px)`
                        }}
                      >
                        <GripVertical size={13} />
                        <span className="signal-name" title={signal.fullName}>
                          {signal.fullName}
                        </span>
                        <small>{catalogUnitLabel(signal)}</small>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </CollapsibleTreeSection>
        </div>

        <div className="saved-views">
          <CollapsibleTreeSection
            collapsed={Boolean(collapsedLeftSections.dataSource)}
            id="dataSource"
            onToggle={toggleLeftSection}
            title="Data Source"
          >
            <div className="view-row active">{signalsSource === "influx" ? "Live InfluxDB" : "Fixture fallback"}</div>
            {signalsError && <div className="inline-alert">{signalsError}</div>}
          </CollapsibleTreeSection>

          <CollapsibleTreeSection
            collapsed={Boolean(collapsedLeftSections.derivedSignal)}
            id="derivedSignal"
            onToggle={toggleLeftSection}
            title="Derived Signal"
          >
            <div className="derived-signal-form">
              <input
                aria-label="Derived signal name"
                placeholder="Name"
                value={derivedName}
                onChange={(event) => setDerivedName(event.target.value)}
              />
              <input
                aria-label="Derived signal variables"
                placeholder="Variables: total_power, blue_power"
                value={derivedVariables}
                onChange={(event) => setDerivedVariables(event.target.value)}
              />
              <input
                aria-label="Derived signal formula"
                placeholder="Formula: total_power - blue_power"
                value={derivedFormula}
                onChange={(event) => setDerivedFormula(event.target.value)}
              />
              <div className="derived-inline">
                <input
                  aria-label="Derived signal unit"
                  placeholder="Unit"
                  value={derivedUnit}
                  onChange={(event) => setDerivedUnit(event.target.value)}
                />
                <button aria-label="Create derived signal" onClick={addDerivedSignal}>
                  Add
                </button>
              </div>
              {derivedSignals.length > 0 && (
                <div className="derived-list">
                  {derivedSignals.map((signal) => (
                    <div className="derived-row" key={signal.id}>
                      <span title={`${signal.name}: ${signal.formula}`}>{signal.name}</span>
                      <button
                        aria-label={`Delete derived signal ${signal.name}`}
                        onClick={() => deleteDerivedSignal(signal.id)}
                        title="Delete derived signal"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CollapsibleTreeSection>

          <CollapsibleTreeSection
            collapsed={Boolean(collapsedLeftSections.savedWorkspaces)}
            id="savedWorkspaces"
            onToggle={toggleLeftSection}
            title="Saved Workspaces"
          >
            <div className="workspace-save">
              <input
                placeholder="Workspace name"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
              <button aria-label="Save workspace" title="Save workspace" onClick={saveNamedWorkspace}>
                <Save size={14} />
              </button>
            </div>
            <div className="saved-workspace-list">
              {savedWorkspaces.length === 0 && <div className="list-state">No saved workspaces.</div>}
              {savedWorkspaces.map((workspace) => (
                <div className="saved-workspace-row" key={workspace.id}>
                  <button aria-label={`Load workspace ${workspace.name}`} title={workspace.name} onClick={() => applyWorkspace(workspace)}>
                    {workspace.name}
                  </button>
                  <button aria-label={`Delete workspace ${workspace.name}`} title="Delete workspace" onClick={() => deleteSavedWorkspace(workspace.id)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </CollapsibleTreeSection>
        </div>
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="title-block">
            <h1>HomeScope</h1>
            <div className="workspace-meta">
              <span>{catalogSignals.length} catalog signals</span>
              <span>{liveMode ? "Live" : "Paused"}</span>
              <span>{panes.length} panes</span>
            </div>
          </div>

          <div className="tool-groups">
            <div className="segmented-control" aria-label="Playback mode">
              <TooltipHost label="Pause live tailing">
                <button
                  aria-label="Pause live tailing"
                  className={!liveMode ? "active" : ""}
                  onClick={() => setLiveMode(false)}
                >
                  <Pause size={15} />
                </button>
              </TooltipHost>
              <TooltipHost label="Start live tailing">
                <button
                  aria-label="Start live tailing"
                  className={liveMode ? "active" : ""}
                  onClick={() => setLiveMode(true)}
                >
                  <Play size={15} />
                </button>
              </TooltipHost>
            </div>
            <div className="segmented-control preset-control" aria-label="Time range">
              {["1m", "30m", "1h", "6h", "24h", "7d"].map((nextPreset) => (
                <TooltipHost key={nextPreset} label={`Show the last ${nextPreset}`}>
                  <button
                    className={preset === nextPreset ? "active" : ""}
                    onClick={() => selectPreset(nextPreset)}
                  >
                    {nextPreset}
                  </button>
                </TooltipHost>
              ))}
            </div>
            <TooltipHost label={liveMode ? `Live mode using the ${rangeLabel} window` : `Paused ${rangeLabel} window`}>
              <button className="toolbar-button" aria-label={`Current range ${liveMode ? `Live ${rangeLabel}` : rangeLabel}`}>
                <Clock3 size={16} />
                {liveMode ? `Live ${rangeLabel}` : rangeLabel}
              </button>
            </TooltipHost>
            <TooltipHost label="Clear the current workspace layout">
              <button className="toolbar-button" aria-label="Clear workspace" onClick={clearWorkspace}>
                <Trash2 size={15} />
                Clear
              </button>
            </TooltipHost>
            <TooltipHost label="Add marker. Press M while hovering panes, or Ctrl-click a chart to place one immediately.">
              <button
                aria-label="Toggle marker placement"
                className={`toolbar-button${markerMode ? " active" : ""}`}
                data-testid="marker-mode-button"
                onClick={() => setMarkerMode((active) => !active)}
              >
                <MapPin size={15} />
                Marker
              </button>
            </TooltipHost>
            <div className="segmented-control measurement-control" aria-label="Measurement cursors">
              {(["A", "B"] as const).map((cursorId) => (
                <TooltipHost key={cursorId} label={`Place ${cursorId} measurement cursor. Shortcut: ${cursorId.toLowerCase()}`}>
                  <button
                    aria-label={`Place ${cursorId} measurement cursor`}
                    className={activeMeasurementCursor === cursorId ? "active" : ""}
                    onClick={() => {
                      setMarkerMode(false);
                      setActiveMeasurementCursor((current) => (current === cursorId ? null : cursorId));
                    }}
                  >
                    {cursorId}
                  </button>
                </TooltipHost>
              ))}
              <TooltipHost label="Clear A and B measurement cursors">
                <button aria-label="Clear measurement cursors" className="measurement-clear-button" onClick={clearMeasurementCursors}>
                  <span>Clear</span>
                  <span>A/B</span>
                </button>
              </TooltipHost>
            </div>
            <div className="interaction-help-shell">
              <TooltipHost label="Keyboard and mouse shortcuts">
                <button
                  aria-expanded={interactionHelpOpen}
                  aria-label="Show keyboard and mouse shortcuts"
                  className={`toolbar-button icon-only${interactionHelpOpen ? " active" : ""}`}
                  data-testid="interaction-help-button"
                  onClick={() => {
                    setRangeEditorOpen(false);
                    setOpenAxisConfig(null);
                    setOpenSignalConfig(null);
                    setInteractionHelpOpen((open) => !open);
                  }}
                  type="button"
                >
                  <HelpCircle size={16} />
                </button>
              </TooltipHost>
              {interactionHelpOpen && (
                <div className="interaction-help-popover" data-testid="interaction-help-popover">
                  <div className="popover-title">Chart shortcuts</div>
                  <p>Shortcuts apply while the mouse is in the panes area.</p>
                  <dl>
                    {interactionHelpItems.map(([key, description]) => (
                      <React.Fragment key={key}>
                        <dt>{key}</dt>
                        <dd>{description}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </div>
              )}
            </div>
            <div className="range-picker">
              <TooltipHost label="Edit the visible start and stop time">
                <button
                  aria-label={`Edit visible time range from ${visibleStartLabel} to ${visibleEndLabel}`}
                  className="toolbar-button range-button"
                  onClick={openRangeEditor}
                >
                  <CalendarClock size={16} />
                  <span>
                    <strong>{visibleStartLabel}</strong>
                    <strong>{visibleEndLabel}</strong>
                  </span>
                </button>
              </TooltipHost>
              {rangeEditorOpen && (
                <div className="range-popover">
                  <label>
                    <span>Start</span>
                    <input
                      type="datetime-local"
                      value={draftStart}
                      onChange={(event) => setDraftStart(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>End</span>
                    <input
                      type="datetime-local"
                      value={draftEnd}
                      onChange={(event) => setDraftEnd(event.target.value)}
                    />
                  </label>
                  <div className="range-actions">
                    <button onClick={() => setRangeEditorOpen(false)}>Cancel</button>
                    <button className="primary" onClick={applyTimeRange}>Apply</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <div
          className="analysis-layout"
          style={{ gridTemplateColumns: `minmax(420px, 1fr) ${rightPanelWidth}px` }}
        >
          <section
            className="chart-surface"
            aria-label="Signal chart workspace"
            onPointerEnter={handlePanesAreaEnter}
            onPointerLeave={handlePanesAreaLeave}
            ref={chartSurfaceRef}
          >
            <div className="time-ruler">
              <span>{visibleStartLabel}</span>
              <span>cursor {formatTime(cursorTime)}</span>
              <span>{visibleEndLabel}</span>
            </div>

            <div
              className={`chart-grid${signalInsertTarget && panes.length === 0 ? " drop-empty" : ""}`}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setPaneDropTarget(null);
                  setSignalInsertTarget(null);
                  stopDragAutoScroll();
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                updateDragPreviewPosition(event);
                updateDragAutoScroll(event);
                if (draggedSignalId) {
                  setPaneDropTarget(null);
                  setSignalInsertTarget({ index: insertIndexFromGridPointer(event.clientY) });
                }
              }}
              onDrop={handleDropToWorkspace}
              ref={chartGridRef}
            >
              {queryError && <div className="workspace-state error">Query failed: {queryError}</div>}
              {panes.length === 0 && signalInsertTarget && (
                <div className="signal-insert-slot" aria-hidden="true" />
              )}
              {panes.map((pane, paneIndex) => {
                const items: LaneItem[] = (["left", "right"] as AxisSide[]).flatMap((side) =>
                  pane.axes[side]
                    .map<LaneItem | null>((signalId, signalIndex) => {
                      const signal = signalById.get(signalId);
                      if (!signal) {
                        return null;
                      }

                      const requestId = paneSignalKey(pane, side, signalIndex);
                      return {
                        color: signalConfigs[requestId]?.color ?? colorFor(paneIndex + signalIndex + (side === "right" ? 3 : 0)),
                        requestId,
                        series: seriesMap[requestId],
                        side,
                        signal,
                        viewConfig: signalConfigs[requestId]
                      };
                    })
                    .filter((item): item is LaneItem => item !== null)
                );
                const leftItems = items.filter((item) => item.side === "left");
                const rightItems = items.filter((item) => item.side === "right");
                const reorderClass =
                  reorderTarget?.paneId === pane.paneId ? ` reorder-${reorderTarget.position}` : "";
                const signalInsertIndex = signalInsertTarget?.index ?? -1;
                const signalInsertClass = signalInsertTarget
                  ? paneIndex < signalInsertIndex ? " signal-nudge-above" : " signal-nudge-below"
                  : "";

                return (
                  <React.Fragment key={pane.paneId}>
                    {signalInsertTarget?.index === paneIndex && (
                      <div className="signal-insert-slot" aria-hidden="true" />
                    )}
                    <article
                      className={`signal-lane${hoveredPaneId === pane.paneId ? " pane-hovered" : ""}${paneDropTarget?.paneId === pane.paneId ? ` drop-${paneDropTarget.side}` : ""}${reorderClass}${signalInsertClass}`}
                      data-testid="signal-lane"
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          setPaneDropTarget(null);
                        }
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        updateDragPreviewPosition(event);
                        updateDragAutoScroll(event);
                        const paneId = event.dataTransfer.getData("application/x-influx-pane");
                        if (paneId) {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setReorderTarget({
                            paneId: pane.paneId,
                            position: event.clientY - rect.top < rect.height / 2 ? "before" : "after"
                          });
                          return;
                        }

                        if (!draggedSignalId) {
                          return;
                        }

                        const rect = event.currentTarget.getBoundingClientRect();
                        const edgeSize = Math.min(44, rect.height * 0.12);
                        const pointerY = event.clientY - rect.top;
                        if (pointerY <= edgeSize) {
                          setPaneDropTarget(null);
                          setSignalInsertTarget({ index: paneIndex });
                        } else if (pointerY >= rect.height - edgeSize) {
                          setPaneDropTarget(null);
                          setSignalInsertTarget({ index: paneIndex + 1 });
                        } else {
                          setSignalInsertTarget(null);
                          setPaneDropTarget({ paneId: pane.paneId, side: dropSideFromEvent(event) });
                        }
                      }}
                      onDrop={(event) => {
                        const movedPaneId = event.dataTransfer.getData("application/x-influx-pane");
                        if (movedPaneId && reorderTarget) {
                          event.preventDefault();
                          event.stopPropagation();
                          movePane(movedPaneId, reorderTarget.paneId, reorderTarget.position);
                          setReorderTarget(null);
                          return;
                        }

                        const signalId = event.dataTransfer.getData("application/x-influx-signal");
                        if (!signalId) {
                          return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        if (signalInsertTarget) {
                          addPaneAt(signalId, signalInsertTarget.index, dropSideFromEvent(event));
                        } else {
                          addSignalToPane(pane.paneId, dropSideFromEvent(event), signalId);
                        }
                        clearSignalDrag();
                      }}
                      onPointerEnter={() => {
                        handlePanesAreaEnter();
                        setHoveredPaneId(pane.paneId);
                      }}
                      onPointerMove={() => {
                        setHoveredPaneId(pane.paneId);
                      }}
                      onPointerLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          setHoveredPaneId((current) => (current === pane.paneId ? null : current));
                        }
                      }}
                    >
                    <header className="lane-header">
                      <div className="lane-title">
                        <button
                          aria-label="Reorder pane"
                          className="lane-drag-handle"
                          draggable
                          onDragEnd={() => setReorderTarget(null)}
                          onDragStart={(event) => {
                            event.dataTransfer.setData("application/x-influx-pane", pane.paneId);
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          title="Reorder pane"
                        >
                          <GripVertical size={15} />
                        </button>
                        <div className="lane-axis-groups">
                          {(["left", "right"] as AxisSide[]).map((side) => {
                            const axisKey = axisConfigKey(pane.paneId, side);
                            const axisConfig = axisConfigs[axisKey] ?? { mode: "auto" as const };
                            return (
                              <div className={`lane-signals ${side}`} key={side}>
                                <button
                                  aria-label={`${side} axis settings`}
                                  className="axis-pill"
                                  data-testid={`axis-settings-${pane.paneId}-${side}`}
                                  title="Axis settings: auto/manual scale, zero baseline, reset"
                                  onClick={() =>
                                    setOpenAxisConfig((current) =>
                                      current?.paneId === pane.paneId && current.side === side
                                        ? null
                                        : { paneId: pane.paneId, side }
                                    )
                                  }
                                  type="button"
                                >
                                  {side}
                                </button>
                                {openAxisConfig?.paneId === pane.paneId && openAxisConfig.side === side && (
                                  <div className="config-popover axis-config-popover" data-testid="axis-config-popover">
                                    <div className="popover-title">{side} axis</div>
                                    <div className="mini-segment">
                                      <button
                                        className={axisConfig.mode !== "manual" ? "active" : ""}
                                        onClick={() => updateAxisConfig(pane.paneId, side, { mode: "auto" })}
                                      >
                                        Auto
                                      </button>
                                      <button
                                        className={axisConfig.mode === "manual" ? "active" : ""}
                                        onClick={() => updateAxisConfig(pane.paneId, side, { mode: "manual" })}
                                      >
                                        Manual
                                      </button>
                                    </div>
                                    <div className="axis-inputs">
                                      <label>
                                        <span>Min</span>
                                        <input
                                          data-testid="axis-min-input"
                                          type="number"
                                          value={axisConfig.min ?? ""}
                                          onChange={(event) =>
                                            updateAxisConfig(pane.paneId, side, {
                                              min: event.target.value === "" ? undefined : Number(event.target.value),
                                              mode: "manual"
                                            })
                                          }
                                        />
                                      </label>
                                      <label>
                                        <span>Max</span>
                                        <input
                                          data-testid="axis-max-input"
                                          type="number"
                                          value={axisConfig.max ?? ""}
                                          onChange={(event) =>
                                            updateAxisConfig(pane.paneId, side, {
                                              max: event.target.value === "" ? undefined : Number(event.target.value),
                                              mode: "manual"
                                            })
                                          }
                                        />
                                      </label>
                                    </div>
                                    <label className="check-row">
                                      <input
                                        checked={Boolean(axisConfig.zeroBaseline)}
                                        type="checkbox"
                                        onChange={(event) =>
                                          updateAxisConfig(pane.paneId, side, {
                                            zeroBaseline: event.target.checked
                                          })
                                        }
                                      />
                                      Zero baseline
                                    </label>
                                    <button className="popover-action" onClick={() => resetAxisConfig(pane.paneId, side)}>
                                      Reset axis
                                    </button>
                                  </div>
                                )}
                                {pane.axes[side].map((signalId, signalIndex) => {
                                  const item = (side === "left" ? leftItems : rightItems).find(
                                    (nextItem) => nextItem.requestId === paneSignalKey(pane, side, signalIndex)
                                  );
                                  if (!item) {
                                    return null;
                                  }

                                  const stats = signalStats(item.signal, item.series);
                                  const config = signalConfigs[item.requestId] ?? {};

                                  return (
                                    <span className="chip-wrap" key={item.requestId}>
                                      <span className={`lane-signal-chip${selectedRequestId === item.requestId ? " selected" : ""}`}>
                                        <span className="swatch" style={{ background: item.color }} />
                                        <strong title={item.signal.fullName}>{item.signal.fullName}</strong>
                                        <small>{item.signal.kind === "state" ? "state" : item.signal.unit}</small>
                                        <button
                                          aria-label={`Signal settings for ${item.signal.fullName}`}
                                          data-testid={`signal-settings-${item.requestId}`}
                                          title="Signal settings: style controls and visible-range stats"
                                          onClick={() =>
                                            setOpenSignalConfig((current) =>
                                              current === item.requestId ? null : item.requestId
                                            )
                                          }
                                        >
                                          <Settings size={11} />
                                        </button>
                                        <button
                                          aria-label={`Remove ${item.signal.fullName}`}
                                          title="Remove signal"
                                          onClick={() => removePaneSignal(pane.paneId, side, signalIndex)}
                                        >
                                          <X size={12} />
                                        </button>
                                      </span>
                                      {openSignalConfig === item.requestId && (
                                        <div className="config-popover signal-config-popover" data-testid="signal-config-popover">
                                          <div className="popover-title">{item.signal.fullName}</div>
                                          <div className="style-swatch-grid" aria-label="Signal color">
                                            {palette.map((color) => (
                                              <button
                                                aria-label={`Set signal color ${color}`}
                                                className={item.color === color ? "active" : ""}
                                                data-testid={`style-color-${color}`}
                                                key={color}
                                                onClick={() => updateSignalConfig(item.requestId, { color })}
                                                style={{ background: color }}
                                                title={color}
                                              />
                                            ))}
                                          </div>
                                          <div className="line-control">
                                            <span>Width</span>
                                            <div className="mini-segment four">
                                              {[1, 2, 3, 4].map((width) => (
                                                <button
                                                  className={(config.lineWidth ?? (item.signal.kind === "state" ? 2.5 : 2)) === width ? "active" : ""}
                                                  key={width}
                                                  onClick={() => updateSignalConfig(item.requestId, { lineWidth: width })}
                                                >
                                                  {width}
                                                </button>
                                              ))}
                                            </div>
                                          </div>
                                          <div className="mini-segment">
                                            {(["solid", "dashed"] as const).map((lineStyle) => (
                                              <button
                                                className={(config.lineStyle ?? "solid") === lineStyle ? "active" : ""}
                                                key={lineStyle}
                                                onClick={() => updateSignalConfig(item.requestId, { lineStyle })}
                                              >
                                                {lineStyle}
                                              </button>
                                            ))}
                                          </div>
                                          <div className="mini-segment three">
                                            {(["line", "points", "linePoints"] as const).map((renderMode) => (
                                              <button
                                                className={(config.renderMode ?? "line") === renderMode ? "active" : ""}
                                                key={renderMode}
                                                onClick={() => updateSignalConfig(item.requestId, { renderMode })}
                                              >
                                                {renderMode === "linePoints" ? "both" : renderMode}
                                              </button>
                                            ))}
                                          </div>
                                          <div className="stats-grid" data-testid="signal-stats">
                                            {item.signal.kind === "state" ? (
                                              <>
                                                <span>Latest</span><strong>{stats.latest}</strong>
                                                <span>Transitions</span><strong>{stats.transitions}</strong>
                                                <span>Dominant</span><strong>{stats.dominant}</strong>
                                              </>
                                            ) : (
                                              <>
                                                <span>Latest</span><strong>{stats.latest}</strong>
                                                <span>Min</span><strong>{stats.min}</strong>
                                                <span>Mean</span><strong>{stats.mean}</strong>
                                                <span>Max</span><strong>{stats.max}</strong>
                                              </>
                                            )}
                                          </div>
                                          {item.signal.kind === "state" && (
                                            <label className="check-row event-source-row">
                                              <input
                                                checked={Boolean(eventOverlays[item.signal.id]?.enabled)}
                                                data-testid={`event-source-toggle-${item.signal.id}`}
                                                type="checkbox"
                                                onChange={(event) => toggleEventOverlay(item.signal.id, event.target.checked)}
                                              />
                                              Event source
                                            </label>
                                          )}
                                        </div>
                                      )}
                                    </span>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <button
                        aria-label="Close pane"
                        className="lane-close"
                        title="Close pane"
                        onClick={() => removePane(pane.paneId)}
                      >
                        <X size={16} />
                      </button>
                    </header>
                    <UPlotLane
                      activeMeasurementCursor={activeMeasurementCursor}
                      axisConfigs={{
                        left: axisConfigs[axisConfigKey(pane.paneId, "left")],
                        right: axisConfigs[axisConfigKey(pane.paneId, "right")]
                      }}
                      cursorTime={cursorTime}
                      eventOverlays={eventOverlayMarkers}
                      items={items}
                      markerMode={markerMode}
                      markers={markers}
                      measurementCursors={measurementCursors}
                      onCursorHover={(hover) => {
                        setCursorHover(hover);
                        setCursorTime(hover.time);
                      }}
                      onCursorLeave={clearCursor}
                      onMarkerCreate={addMarker}
                      onMeasurementCursorSet={setMeasurementCursor}
                      onPaneHover={(hover) => {
                        cancelKeyboardZoomLeaveClear();
                        setHoveredPaneId(pane.paneId);
                        setLastPlotHover({ ...hover, paneId: pane.paneId });
                      }}
                      onPaneLeave={() => {
                        setHoveredPaneId((current) => (current === pane.paneId ? null : current));
                      }}
                      onPlotSelect={(selection) => {
                        setHoveredPaneId(pane.paneId);
                        setLastPlotHover({ ...selection, paneId: pane.paneId });
                        setSelectedRequestId((current) => (current === selection.requestId ? null : selection.requestId));
                      }}
                      onRangeSelected={(start, end) => {
                        updateViewportFromSelection(start, end);
                      }}
                      onResetZoom={() => resetPaneAndViewport(pane.paneId)}
                      onYRangeSelected={(ranges) => updatePaneYRange(pane.paneId, ranges)}
                      xRange={{
                        max: viewport.end.getTime() / 1000,
                        min: viewport.start.getTime() / 1000
                      }}
                      yRanges={paneYRanges[pane.paneId]}
                    />
                    </article>
                  </React.Fragment>
                );
              })}
              {panes.length > 0 && signalInsertTarget?.index === panes.length && (
                <div className="signal-insert-slot" aria-hidden="true" />
              )}
            </div>

            {queryLoading && panes.length > 0 && (
              <div className="query-activity" data-testid="query-activity" aria-live="polite">
                <span className="query-spinner" />
                <span>Querying</span>
              </div>
            )}

            <div className="mobile-status-strip" data-testid="mobile-status-strip" aria-live="polite">
              <span>{queryLoading ? "Query active" : "Query idle"}</span>
              <span>Zoom {keyboardZoomLabel}</span>
              <span>Marker {markerMode ? "Armed" : "Off"}</span>
              <span>{selectedSignalLabel === "None" ? panesShortcutState : selectedSignalLabel}</span>
            </div>

            <footer
              className="overview-strip"
              onPointerDown={(event) => recenterViewport(event.clientX)}
              ref={overviewRef}
            >
              <span className="overview-fill" />
              <span
                className="overview-window"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  startOverviewDrag(event);
                }}
                onPointerMove={moveOverviewDrag}
                onPointerUp={stopOverviewDrag}
                onPointerCancel={stopOverviewDrag}
                style={{
                  left: `${overviewLeftPct}%`,
                  width: `${overviewWidthPct}%`
                }}
              />
            </footer>
          </section>

          <aside className="inspector-panel">
            <button
              aria-label="Resize inspector"
              className="panel-resize-handle right"
              onPointerCancel={stopPanelResize}
              onPointerDown={(event) => startPanelResize("right", event)}
              onPointerMove={movePanelResize}
              onPointerUp={stopPanelResize}
              title="Resize inspector"
            />
            <CollapsibleInspectorSection
              collapsed={Boolean(collapsedInspectorSections.cursor)}
              icon={<Crosshair size={16} />}
              id="cursor"
              title="Cursor"
              onToggle={toggleInspectorSection}
            >
              <div className="metric-grid">
                <div>
                  <span>Time</span>
                  <strong>{readoutUsesCursor ? formatTime(cursorTime) : liveMode ? "Live latest" : "Latest"}</strong>
                </div>
                <div>
                  <span>Range</span>
                  <strong>{rangeLabel}{liveMode ? " live" : ""}</strong>
                </div>
              </div>
            </CollapsibleInspectorSection>

            <CollapsibleInspectorSection
              collapsed={Boolean(collapsedInspectorSections.readout)}
              headerExtra={
                liveReadout && (
                  <span className="live-readout">
                    <span className="live-dot" />
                    LIVE
                  </span>
                )
              }
              icon={<SlidersHorizontal size={16} />}
              id="readout"
              title="Readout"
              onToggle={toggleInspectorSection}
            >
              <div className="readout-list">
                {panes.flatMap((pane, paneIndex) =>
                  (["left", "right"] as AxisSide[]).flatMap((side) =>
                    pane.axes[side].map((signalId, signalIndex) => {
                      const signal = signalById.get(signalId);
                      if (!signal) {
                        return null;
                      }
                      const requestId = paneSignalKey(pane, side, signalIndex);
                      const color = signalConfigs[requestId]?.color ?? colorFor(paneIndex + signalIndex + (side === "right" ? 3 : 0));
                      return (
                        <div className="readout-row" key={requestId}>
                          <span
                            className="swatch"
                            style={{
                              background: color
                            }}
                          />
                          <span title={signal.fullName}>{signal.fullName}</span>
                          <strong>
                            {valueLabel(
                              signal,
                              seriesMap[requestId],
                              readoutUsesCursor ? cursorTime : undefined
                            )}
                          </strong>
                        </div>
                      );
                    })
                  )
                )}
              </div>
            </CollapsibleInspectorSection>

            <CollapsibleInspectorSection
              collapsed={Boolean(collapsedInspectorSections.selectedSignal)}
              icon={<Activity size={16} />}
              id="selectedSignal"
              title="Selected Signal"
              onToggle={toggleInspectorSection}
            >
              <div className="query-card selected-signal-card" data-testid="selected-signal-card">
                {!selectedContext || !selectedStats ? (
                  <>
                    <span>Signal</span>
                    <strong>None</strong>
                  </>
                ) : (
                  <>
                    <span>Signal</span>
                    <strong title={selectedContext.signal.fullName}>{selectedContext.signal.fullName}</strong>
                    {selectedContext.signal.kind === "state" ? (
                      <>
                        <span>Latest</span><strong>{selectedStats.latest}</strong>
                        <span>Transitions</span><strong>{selectedStats.transitions}</strong>
                        <span>Dominant</span><strong>{selectedStats.dominant}</strong>
                      </>
                    ) : (
                      <>
                        <span>Latest</span><strong>{selectedStats.latest}</strong>
                        <span>Min</span><strong>{selectedStats.min}</strong>
                        <span>Mean</span><strong>{selectedStats.mean}</strong>
                        <span>Max</span><strong>{selectedStats.max}</strong>
                      </>
                    )}
                  </>
                )}
              </div>
            </CollapsibleInspectorSection>

            <CollapsibleInspectorSection
              collapsed={Boolean(collapsedInspectorSections.measurements)}
              icon={<Crosshair size={16} />}
              id="measurements"
              title="Measurements"
              onToggle={toggleInspectorSection}
            >
              <div className="query-card" data-testid="measurement-card">
                <span>A</span>
                <strong>{cursorA === null ? "--" : formatTime(cursorA)}</strong>
                <span>B</span>
                <strong>{cursorB === null ? "--" : formatTime(cursorB)}</strong>
                <span>Delta time</span>
                <strong data-testid="measurement-delta-time">
                  {cursorA === null || cursorB === null ? "--" : `${Math.abs(cursorB - cursorA).toFixed(1)} s`}
                </strong>
                <span>{selectedContext?.signal.kind === "state" ? "A state" : "A value"}</span>
                <strong>{selectedContext ? selectedAValue : "--"}</strong>
                <span>{selectedContext?.signal.kind === "state" ? "B state" : "B value"}</span>
                <strong>{selectedContext ? selectedBValue : "--"}</strong>
                <span>{selectedContext?.signal.kind === "state" ? "State" : "Delta"}</span>
                <strong data-testid="measurement-delta-value">{selectedContext ? selectedDeltaValue : "--"}</strong>
              </div>
            </CollapsibleInspectorSection>

            <CollapsibleInspectorSection
              collapsed={Boolean(collapsedInspectorSections.markers)}
              icon={<MapPin size={16} />}
              id="markers"
              title="Markers"
              onToggle={toggleInspectorSection}
            >
              <div className="marker-actions">
                <button onClick={exportMarkers}>Export markers</button>
                <button onClick={() => markerImportRef.current?.click()}>Import markers</button>
                <input
                  accept="application/json"
                  data-testid="marker-import-input"
                  ref={markerImportRef}
                  type="file"
                  onChange={(event) => {
                    importMarkers(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
              <div className="marker-list">
                {markers.length === 0 && <div className="list-state compact">No markers.</div>}
                {markers.map((marker) => (
                  <div className="marker-row" data-testid="marker-row" key={marker.id}>
                    <span className="swatch" style={{ background: marker.color }} />
                    <input
                      aria-label="Marker label"
                      data-testid={`marker-label-${marker.id}`}
                      value={marker.label}
                      onChange={(event) => updateMarker(marker.id, { label: event.target.value })}
                    />
                    <small>{formatTime(marker.timestamp)}</small>
                    <button aria-label={`Delete marker ${marker.label}`} title="Delete marker" onClick={() => deleteMarker(marker.id)}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </CollapsibleInspectorSection>

            <CollapsibleInspectorSection
              collapsed={Boolean(collapsedInspectorSections.query)}
              icon={<Zap size={16} />}
              id="query"
              title="Query"
              onToggle={toggleInspectorSection}
            >
              <div className="query-card">
                <span>Status</span>
                <strong className={`query-status${queryLoading ? " active" : ""}`} data-testid="query-status">
                  {queryLoading && <span className="query-spinner" />}
                  {queryLoading ? "Active" : "Idle"}
                </strong>
                <span>Source</span>
                <strong>{signalsSource === "influx" ? "InfluxDB 1.x" : signalsSource === "fixture" ? "Setup fixtures" : "Unavailable"}</strong>
                <span>Visible series</span>
                <strong>{queryStatus.visibleSeries}</strong>
                <span>Unique queries</span>
                <strong data-testid="unique-query-count">{queryStatus.uniqueQueries}</strong>
                <span>Max points</span>
                <strong data-testid="query-max-points">{queryStatus.maxPoints}</strong>
                <span>Last query</span>
                <strong>{queryStatus.durationMs ? `${queryStatus.durationMs} ms` : "--"}</strong>
                <span>Signal catalog</span>
                <strong>{catalogSignals.length}</strong>
              </div>
            </CollapsibleInspectorSection>
          </aside>
        </div>
      </section>
      {draggedSignal && dragPreviewPosition && (
        <div
          aria-hidden="true"
          className="signal-drag-preview"
          style={{
            transform: `translate3d(${dragPreviewPosition.x + 16}px, ${dragPreviewPosition.y + 14}px, 0)`
          }}
        >
          <span className="swatch" style={{ background: colorFor(draggedSignalIndex) }} />
          <span>{draggedSignal.fullName}</span>
          {draggedSignalUnit && <small>{draggedSignalUnit}</small>}
        </div>
      )}
      <img
        ref={dragImageRef}
        className="native-signal-drag-image"
        src={transparentDragImageSrc}
        alt=""
        aria-hidden="true"
      />
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
