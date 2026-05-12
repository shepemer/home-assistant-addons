import React from "react";
import uPlot from "uplot";
import type { QuerySeries, Signal } from "./api";

export type AxisSide = "left" | "right";

export type ScaleRange = {
  min: number;
  max: number;
};

export type LineStyle = "solid" | "dashed";
export type RenderMode = "line" | "points" | "linePoints";

export type SignalViewConfig = {
  color?: string;
  lineStyle?: LineStyle;
  lineWidth?: number;
  renderMode?: RenderMode;
};

export type AxisConfig = {
  max?: number;
  min?: number;
  mode: "auto" | "manual";
  zeroBaseline?: boolean;
};

export type Marker = {
  color: string;
  id: string;
  label: string;
  timestamp: number;
};

export type MeasurementCursor = {
  id: "A" | "B";
  timestamp: number | null;
};

export type EventOverlay = {
  color: string;
  id: string;
  label: string;
  timestamp: number;
};

export type CursorHover = {
  requestId: string;
  side: AxisSide;
  time: number;
  x: number;
  y: number;
};

export type PlotInteraction = CursorHover & {
  axisValue: number;
  signalId: string;
};

export type LaneItem = {
  color: string;
  requestId: string;
  series?: QuerySeries;
  side: AxisSide;
  signal: Signal;
  viewConfig?: SignalViewConfig;
};

type DragMode = "x" | "y" | "xy";

type DragOverlay = {
  mode: DragMode;
  left: number;
  top: number;
  width: number;
  height: number;
};

type AxisTick = {
  label: string;
  top: number;
};

type DragStart = {
  pointerId: number;
  side: AxisSide;
  x: number;
  y: number;
};

type UPlotLaneProps = {
  axisConfigs?: Partial<Record<AxisSide, AxisConfig>>;
  cursorTime?: number;
  items: LaneItem[];
  markerMode?: boolean;
  markers?: Marker[];
  measurementCursors?: MeasurementCursor[];
  eventOverlays?: EventOverlay[];
  activeMeasurementCursor?: "A" | "B" | null;
  onCursorHover: (hover: CursorHover) => void;
  onCursorLeave: () => void;
  onMarkerCreate?: (timestamp: number) => void;
  onMeasurementCursorSet?: (cursorId: "A" | "B", timestamp: number) => void;
  onPaneHover?: (hover: PlotInteraction) => void;
  onPaneLeave?: () => void;
  onPlotSelect?: (selection: PlotInteraction) => void;
  onRangeSelected: (start: Date, end: Date) => void;
  onResetZoom: () => void;
  onYRangeSelected: (ranges: Partial<Record<AxisSide, ScaleRange>>) => void;
  xRange: ScaleRange;
  yRanges?: Partial<Record<AxisSide, ScaleRange>>;
};

const dragThresholdPx = 8;
const diagonalThresholdPx = 18;
const directionalRatio = 2.4;
const minHorizontalZoomSeconds = 60;
const minPlotWidth = 320;
const plotHeight = 232;

function alignedDataFor(items: LaneItem[]) {
  const tables = items.map((item) => [
    item.series?.time ?? [],
    item.series?.values ?? []
  ]) as unknown as uPlot.AlignedData[];

  if (tables.length === 0) {
    return [[]] as unknown as uPlot.AlignedData;
  }

  return uPlot.join(tables, tables.map(() => [0]));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function plotSizeFor(plotShell: HTMLDivElement) {
  return {
    width: Math.max(Math.round(plotShell.clientWidth), minPlotWidth),
    height: plotHeight
  };
}

function dragModeFor(dx: number, dy: number): DragMode | null {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  if (Math.hypot(dx, dy) < dragThresholdPx) {
    return null;
  }

  if (ady < diagonalThresholdPx || adx >= ady * directionalRatio) {
    return "x";
  }

  if (adx < diagonalThresholdPx || ady >= adx * directionalRatio) {
    return "y";
  }

  return "xy";
}

function plotRect(plot: uPlot, plotShell?: HTMLDivElement | null) {
  if (plotShell) {
    return {
      height: Math.max(plotShell.clientHeight, 1),
      left: 0,
      top: 0,
      width: Math.max(plotShell.clientWidth, 1)
    };
  }

  const bbox = (plot as uPlot & { bbox?: { height: number; left: number; top: number; width: number } }).bbox;

  return {
    height: bbox?.height ?? 1,
    left: bbox?.left ?? 0,
    top: bbox?.top ?? 0,
    width: bbox?.width ?? 1
  };
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

function stateLabel(series: QuerySeries | undefined, value: number | null | undefined, index: number) {
  if (index >= 0) {
    return series?.states?.[index] ?? "--";
  }

  if (value === null || value === undefined) {
    return "--";
  }

  return (
    Object.entries(series?.stateMap ?? {}).find(([, mapped]) => mapped === value)?.[0] ??
    String(value)
  );
}

function valueLabel(item: LaneItem, timestamp: number | undefined) {
  const index = nearestIndex(item.series, timestamp);

  if (item.signal.kind === "state") {
    return stateLabel(item.series, index >= 0 ? item.series?.values[index] : undefined, index);
  }

  const value = index >= 0 ? item.series?.values[index] : undefined;
  if (value === null || value === undefined) {
    return "--";
  }

  return `${value.toFixed(Math.abs(value) >= 100 ? 1 : 2)} ${item.signal.unit}`;
}

function axisUnit(items: LaneItem[], side: AxisSide) {
  return items.find((item) => item.side === side)?.signal.unit ?? "";
}

function itemsForSide(items: LaneItem[], side: AxisSide) {
  return items.filter((item) => item.side === side);
}

function stateItemsForSide(items: LaneItem[], side: AxisSide) {
  const nextItems = itemsForSide(items, side);
  return nextItems.length > 0 && nextItems.every((item) => item.signal.kind === "state") ? nextItems : [];
}

function stateLevelEntries(items: LaneItem[]) {
  const entries = new Map<number, string>();

  for (const item of items) {
    for (const [label, value] of Object.entries(item.series?.stateMap ?? {})) {
      entries.set(value, label);
    }

    item.series?.values.forEach((value, index) => {
      if (value === null || value === undefined) {
        return;
      }
      entries.set(value, item.series?.states?.[index] ?? String(value));
    });
  }

  if (entries.size === 0) {
    entries.set(0, "state");
  }

  return [...entries.entries()].sort(([left], [right]) => left - right);
}

function niceStep(span: number, targetIntervals: number) {
  if (!Number.isFinite(span) || span <= 0) {
    return 1;
  }

  const roughStep = span / targetIntervals;
  const exponent = Math.floor(Math.log10(roughStep));
  const magnitude = 10 ** exponent;
  const normalized = roughStep / magnitude;
  const niceNormalized =
    normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 5
          ? 5
          : 10;

  return niceNormalized * magnitude;
}

function niceNumericRange(min: number, max: number): ScaleRange {
  if (min === max) {
    const padding = Math.max(Math.abs(max) * 0.1, 1);
    return {
      min: min - padding,
      max: max + padding
    };
  }

  const span = max - min;
  const touchesOrCrossesZero = min <= 0;
  const allPositiveNearZero = min > 0 && min <= span * 0.05;
  const baselineMin = allPositiveNearZero ? 0 : min;
  const step = niceStep(max - baselineMin, 4);
  const niceMin = touchesOrCrossesZero
    ? Math.floor((min - step * 0.25) / step) * step
    : allPositiveNearZero
      ? 0
      : Math.floor(baselineMin / step) * step;
  const niceMax = Math.ceil(max / step) * step;

  if (niceMin === niceMax) {
    return {
      min: niceMin - step,
      max: niceMax + step
    };
  }

  return {
    min: niceMin,
    max: niceMax
  };
}

function paddedNumericRange(range: ScaleRange) {
  const span = range.max - range.min;
  const padding = Math.max(span * 0.06, 0.01);

  return {
    min: range.min - padding,
    max: range.max + padding
  };
}

function numericRangeForSide(items: LaneItem[], side: AxisSide): ScaleRange | null {
  const values = itemsForSide(items, side)
    .filter((item) => item.signal.kind !== "state")
    .flatMap((item) => item.series?.values ?? [])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (values.length === 0) {
    return null;
  }

  return niceNumericRange(Math.min(...values), Math.max(...values));
}

function scaleForSide(
  items: LaneItem[],
  side: AxisSide,
  range: ScaleRange | undefined,
  axisConfig?: AxisConfig
): uPlot.Scale {
  if (
    axisConfig?.mode === "manual" &&
    Number.isFinite(axisConfig.min) &&
    Number.isFinite(axisConfig.max) &&
    axisConfig.min !== axisConfig.max
  ) {
    return { auto: false, max: axisConfig.max, min: axisConfig.min };
  }

  if (range) {
    return { auto: false, max: range.max, min: range.min };
  }

  const stateItems = stateItemsForSide(items, side);
  if (stateItems.length > 0) {
    const levels = stateLevelEntries(stateItems).map(([value]) => value);
    const maxLevel = Math.max(...levels, 0);
    return {
      auto: false,
      max: maxLevel + 0.5,
      min: -0.5
    };
  }

  const numericRange = numericRangeForSide(items, side);
  if (numericRange) {
    const zeroRange = axisConfig?.zeroBaseline
      ? {
          max: Math.max(0, numericRange.max),
          min: Math.min(0, numericRange.min)
        }
      : numericRange;

    const paddedRange = paddedNumericRange(zeroRange);

    return {
      auto: false,
      max: paddedRange.max,
      min: paddedRange.min
    };
  }

  return { auto: false, max: 1, min: 0 };
}

function formatAxisTick(value: number) {
  const absoluteValue = Math.abs(value);
  const abbreviatedUnits = [
    { suffix: "B", value: 1_000_000_000 },
    { suffix: "M", value: 1_000_000 },
    { suffix: "K", value: 1_000 }
  ];
  const abbreviatedUnit = abbreviatedUnits.find((unit) => absoluteValue >= unit.value);

  if (abbreviatedUnit) {
    const scaled = value / abbreviatedUnit.value;
    const fixed =
      Math.abs(scaled) >= 100
        ? scaled.toFixed(0)
        : Math.abs(scaled) >= 10
          ? scaled.toFixed(1)
          : scaled.toFixed(2);

    return `${fixed.replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")}${abbreviatedUnit.suffix}`;
  }

  const fixed =
    absoluteValue >= 100
      ? value.toFixed(0)
      : absoluteValue >= 10
        ? value.toFixed(1)
        : value.toFixed(2);

  return fixed.replace(/\.0+$|(\.\d*[1-9])0+$/, "$1");
}

function axisTicksFor(plot: uPlot, items: LaneItem[], side: AxisSide, enabled: boolean): AxisTick[] {
  if (!enabled) {
    return [];
  }

  const scale = plot.scales[side];
  const min = Number(scale?.min);
  const max = Number(scale?.max);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [];
  }

  const stateItems = stateItemsForSide(items, side);
  if (stateItems.length > 0) {
    return stateLevelEntries(stateItems).map(([value, label]) => ({
      label,
      top: clamp(100 - ((value - min) / (max - min)) * 100, 7, 93)
    }));
  }

  const step = niceStep(max - min, 5);
  const values: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 0.1; value += step) {
    values.push(Number(value.toPrecision(12)));
  }

  return values.reverse().map((value) => ({
    label: formatAxisTick(value),
    top: clamp(100 - ((value - min) / (max - min)) * 100, 7, 93)
  }));
}

function plotSignature(
  items: LaneItem[],
  xRange: ScaleRange,
  yRanges?: Partial<Record<AxisSide, ScaleRange>>,
  axisConfigs?: Partial<Record<AxisSide, AxisConfig>>
) {
  return JSON.stringify({
    axisConfigs: axisConfigs ?? {},
    ranges: yRanges ?? {},
    xRange,
    series: items.map((item) => {
      const lastIndex = (item.series?.time.length ?? 0) - 1;
      return {
        color: item.color,
        id: item.requestId,
        kind: item.signal.kind,
        side: item.side,
        signalId: item.signal.id,
        viewConfig: item.viewConfig ?? {},
        stateData: item.series?.states?.join("\u001f") ?? "",
        timeData: item.series?.time.join(",") ?? "",
        timeEnd: lastIndex >= 0 ? item.series?.time[lastIndex] : null,
        timeLength: item.series?.time.length ?? 0,
        timeStart: item.series?.time[0] ?? null,
        valueData: item.series?.values.map((value) => value ?? "").join(",") ?? "",
        valueEnd: lastIndex >= 0 ? item.series?.values[lastIndex] : null,
        valueLength: item.series?.values.length ?? 0,
        valueStart: item.series?.values[0] ?? null
      };
    })
  });
}

export function UPlotLane({
  axisConfigs,
  cursorTime,
  items,
  markerMode = false,
  markers = [],
  measurementCursors = [],
  eventOverlays = [],
  activeMeasurementCursor = null,
  onCursorHover,
  onCursorLeave,
  onMarkerCreate,
  onMeasurementCursorSet,
  onPaneHover,
  onPaneLeave,
  onPlotSelect,
  onRangeSelected,
  onResetZoom,
  onYRangeSelected,
  xRange,
  yRanges
}: UPlotLaneProps) {
  const plotShellRef = React.useRef<HTMLDivElement | null>(null);
  const plotRef = React.useRef<uPlot | null>(null);
  const ctrlMarkerCreatedRef = React.useRef(false);
  const dragStartRef = React.useRef<DragStart | null>(null);
  const latestCursorHoverRef = React.useRef(onCursorHover);
  const latestCursorLeaveRef = React.useRef(onCursorLeave);
  const latestPaneHoverRef = React.useRef(onPaneHover);
  const latestPaneLeaveRef = React.useRef(onPaneLeave);
  const latestPlotSelectRef = React.useRef(onPlotSelect);
  const latestRangeRef = React.useRef(onRangeSelected);
  const latestYRangeRef = React.useRef(onYRangeSelected);
  const [dragOverlay, setDragOverlay] = React.useState<DragOverlay | null>(null);
  const [tooltip, setTooltip] = React.useState<{
    color: string;
    label: string;
    signal: string;
    x: number;
    y: number;
  } | null>(null);
  const [axisTicks, setAxisTicks] = React.useState<Record<AxisSide, AxisTick[]>>({
    left: [],
    right: []
  });
  const signature = plotSignature(items, xRange, yRanges, axisConfigs);
  const hasLeft = items.some((item) => item.side === "left");
  const hasRight = items.some((item) => item.side === "right");

  React.useEffect(() => {
    latestCursorHoverRef.current = onCursorHover;
  }, [onCursorHover]);

  React.useEffect(() => {
    latestCursorLeaveRef.current = onCursorLeave;
  }, [onCursorLeave]);

  React.useEffect(() => {
    latestPaneHoverRef.current = onPaneHover;
  }, [onPaneHover]);

  React.useEffect(() => {
    latestPaneLeaveRef.current = onPaneLeave;
  }, [onPaneLeave]);

  React.useEffect(() => {
    latestPlotSelectRef.current = onPlotSelect;
  }, [onPlotSelect]);

  React.useEffect(() => {
    latestRangeRef.current = onRangeSelected;
  }, [onRangeSelected]);

  React.useEffect(() => {
    latestYRangeRef.current = onYRangeSelected;
  }, [onYRangeSelected]);

  React.useEffect(() => {
    const plotShell = plotShellRef.current;
    if (!plotShell) {
      return;
    }

    const data = alignedDataFor(items);
    const scales: Record<string, uPlot.Scale> = {
      x: {
        max: xRange.max,
        min: xRange.min,
        time: true
      },
      left: scaleForSide(items, "left", yRanges?.left, axisConfigs?.left),
      right: scaleForSide(items, "right", yRanges?.right, axisConfigs?.right)
    };

    const options: uPlot.Options = {
      ...plotSizeFor(plotShell),
      select: {
        height: 0,
        left: 0,
        show: false,
        top: 0,
        width: 0
      },
      cursor: {
        drag: {
          setScale: false,
          x: false,
          y: false
        }
      },
      legend: {
        show: false
      },
      hooks: {
        ready: [
          (plot) => {
            setAxisTicks({
              left: axisTicksFor(plot, items, "left", hasLeft),
              right: axisTicksFor(plot, items, "right", hasRight)
            });
          }
        ],
        setCursor: [
          (plot) => {
            const index = plot.cursor.idx;
            if (typeof index !== "number") {
              return;
            }

            const time = data[0]?.[index];
            if (typeof time !== "number") {
              return;
            }

            let hoveredItem = items[0];
            let bestDistance = Number.POSITIVE_INFINITY;
            const cursorTop = plot.cursor.top ?? 0;

            for (const item of items) {
              const itemIndex = nearestIndex(item.series, time);
              const value = itemIndex >= 0 ? item.series?.values[itemIndex] : undefined;
              if (value === null || value === undefined) {
                continue;
              }

              const top = plot.valToPos(value, item.side);
              if (!Number.isFinite(top)) {
                continue;
              }

              const distance = Math.abs(top - cursorTop);
              if (distance < bestDistance) {
                bestDistance = distance;
                hoveredItem = item;
              }
            }

            if (!hoveredItem) {
              return;
            }

            const x = clamp(plot.cursor.left ?? 0, 0, plotShell.clientWidth);
            const y = clamp(plot.cursor.top ?? 0, 0, plotShell.clientHeight);
            latestCursorHoverRef.current({
              requestId: hoveredItem.requestId,
              side: hoveredItem.side,
              time,
              x,
              y
            });
            setTooltip({
              color: hoveredItem.viewConfig?.color ?? hoveredItem.color,
              label: valueLabel(hoveredItem, time),
              signal: hoveredItem.signal.fullName,
              x,
              y
            });
          }
        ]
      },
      axes: [
        {
          show: false
        },
        {
          scale: "left",
          show: false,
          size: 0
        },
        {
          scale: "right",
          show: false,
          size: 0
        }
      ],
      scales,
      series: [
        {},
        ...items.map((item) => {
          const color = item.viewConfig?.color ?? item.color;
          const renderMode = item.viewConfig?.renderMode ?? "line";
          const lineWidth = item.viewConfig?.lineWidth ?? (item.signal.kind === "state" ? 2.5 : 2);

          return {
            label: item.signal.fullName,
            scale: item.side,
            stroke: color,
            width: renderMode === "points" ? 0 : lineWidth,
            dash: item.viewConfig?.lineStyle === "dashed" ? [8, 6] : undefined,
            spanGaps: true,
            paths:
              item.signal.kind === "state"
                ? uPlot.paths.stepped?.({ align: 1, ascDesc: true })
                : undefined,
            points: {
              fill: color,
              show: renderMode === "points" || renderMode === "linePoints",
              size: Math.max(lineWidth + 3, 5),
              stroke: color,
              width: 1
            },
            value: (_plot: uPlot, value: unknown) => {
              if (value === null || value === undefined) {
                return "--";
              }

              if (item.signal.kind === "state") {
                return stateLabel(item.series, Number(value), -1);
              }

              return `${Number(value).toFixed(2)} ${item.signal.unit}`;
            }
          };
        })
      ]
    };

    plotRef.current?.destroy();
    plotRef.current = new uPlot(options, data, plotShell);

    const observer = new ResizeObserver(() => {
      const plot = plotRef.current;
      if (!plot || !plotShellRef.current) {
        return;
      }

      plot.setSize(plotSizeFor(plotShellRef.current));
      setAxisTicks({
        left: axisTicksFor(plot, items, "left", hasLeft),
        right: axisTicksFor(plot, items, "right", hasRight)
      });
    });
    observer.observe(plotShell);

    return () => {
      observer.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [signature, hasLeft, hasRight, xRange.max, xRange.min]);

  React.useEffect(() => {
    const plot = plotRef.current;
    const plotShell = plotShellRef.current;
    if (!plot || !plotShell || cursorTime === undefined) {
      return;
    }

    const left = plot.valToPos(cursorTime, "x");
    if (!Number.isFinite(left)) {
      return;
    }

    plot.setCursor(
      {
        left,
        top: plot.cursor.top ?? Math.max(plotShell.clientHeight / 2, 1)
      },
      false
    );
  }, [cursorTime, signature]);

  const pointerPosition = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      side: (event.clientX - rect.left < rect.width / 2 ? "left" : "right") as AxisSide,
      x: clamp(event.clientX - rect.left, 0, rect.width),
      y: clamp(event.clientY - rect.top, 0, rect.height)
    };
  }, []);

  const nearestInteractionAt = React.useCallback((x: number, y: number): PlotInteraction | null => {
    const plot = plotRef.current;
    if (!plot || items.length === 0) {
      return null;
    }

    const time = plot.posToVal(x, "x");
    if (!Number.isFinite(time)) {
      return null;
    }

    let hoveredItem: LaneItem | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const item of items) {
      const itemIndex = nearestIndex(item.series, time);
      const value = itemIndex >= 0 ? item.series?.values[itemIndex] : undefined;
      if (value === null || value === undefined) {
        continue;
      }

      const top = plot.valToPos(value, item.side);
      if (!Number.isFinite(top)) {
        continue;
      }

      const distance = Math.abs(top - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        hoveredItem = item;
      }
    }

    if (!hoveredItem) {
      hoveredItem = items[0];
    }

    return {
      axisValue: plot.posToVal(y, hoveredItem.side),
      requestId: hoveredItem.requestId,
      side: hoveredItem.side,
      signalId: hoveredItem.signal.id,
      time,
      x,
      y
    };
  }, [items]);

  const itemForRequest = React.useCallback((requestId: string) => {
    return items.find((item) => item.requestId === requestId);
  }, [items]);

  const updateHoverAt = React.useCallback((x: number, y: number) => {
    const plot = plotRef.current;
    const hover = nearestInteractionAt(x, y);
    if (!plot || !hover) {
      return;
    }

    const hoveredItem = itemForRequest(hover.requestId);
    if (!hoveredItem) {
      return;
    }

    plot.setCursor({ left: x, top: y }, false);
    latestCursorHoverRef.current(hover);
    latestPaneHoverRef.current?.(hover);
    setTooltip({
      color: hoveredItem.viewConfig?.color ?? hoveredItem.color,
      label: valueLabel(hoveredItem, hover.time),
      signal: hoveredItem.signal.fullName,
      x,
      y
    });
  }, [itemForRequest, nearestInteractionAt]);

  const timestampAt = React.useCallback((x: number) => {
    const plot = plotRef.current;
    if (!plot) {
      return null;
    }

    const timestamp = plot.posToVal(x, "x");
    return Number.isFinite(timestamp) ? timestamp : null;
  }, []);

  const createMarkerAt = React.useCallback((x: number) => {
    const timestamp = timestampAt(x);
    if (timestamp !== null && onMarkerCreate) {
      onMarkerCreate(timestamp);
    }
  }, [onMarkerCreate, timestampAt]);

  const setMeasurementCursorAt = React.useCallback((x: number) => {
    const timestamp = timestampAt(x);
    if (timestamp !== null && activeMeasurementCursor && onMeasurementCursorSet) {
      onMeasurementCursorSet(activeMeasurementCursor, timestamp);
    }
  }, [activeMeasurementCursor, onMeasurementCursorSet, timestampAt]);

  const updateOverlay = React.useCallback((start: DragStart, mode: DragMode, x: number, y: number) => {
    const plot = plotRef.current;
    if (!plot) {
      return;
    }

    const bounds = plotRect(plot, plotShellRef.current);
    const startX = clamp(start.x, bounds.left, bounds.left + bounds.width);
    const currentX = clamp(x, bounds.left, bounds.left + bounds.width);
    const startY = clamp(start.y, bounds.top, bounds.top + bounds.height);
    const currentY = clamp(y, bounds.top, bounds.top + bounds.height);

    if (mode === "x") {
      const left = Math.min(startX, currentX);
      setDragOverlay({
        height: bounds.height,
        left,
        mode: "x",
        top: bounds.top,
        width: Math.abs(currentX - startX)
      });
      return;
    }

    if (mode === "y") {
      const top = Math.min(startY, currentY);
      setDragOverlay({
        height: Math.abs(currentY - startY),
        left: bounds.left,
        mode: "y",
        top,
        width: bounds.width
      });
      return;
    }

    setDragOverlay({
      height: Math.abs(currentY - startY),
      left: Math.min(startX, currentX),
      mode: "xy",
      top: Math.min(startY, currentY),
      width: Math.abs(currentX - startX)
    });
  }, []);

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      const { side, x, y } = pointerPosition(event);
      if (event.ctrlKey && onMarkerCreate) {
        ctrlMarkerCreatedRef.current = true;
        createMarkerAt(x);
        return;
      }
      ctrlMarkerCreatedRef.current = false;
      dragStartRef.current = {
        pointerId: event.pointerId,
        side,
        x,
        y
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [createMarkerAt, onMarkerCreate, pointerPosition]
  );

  const abortDrag = React.useCallback((target?: HTMLDivElement | null, pointerId?: number) => {
    dragStartRef.current = null;
    setDragOverlay(null);

    if (target && pointerId !== undefined && target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  }, []);

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.focus({ preventScroll: true });
      const start = dragStartRef.current;
      if (!start) {
        const { x, y } = pointerPosition(event);
        updateHoverAt(x, y);
        return;
      }

      if (event.pointerId !== start.pointerId) {
        return;
      }

      if ((event.buttons & 1) === 0) {
        abortDrag(event.currentTarget, start.pointerId);
        return;
      }

      const { x, y } = pointerPosition(event);
      const dx = x - start.x;
      const dy = y - start.y;

      const mode = dragModeFor(dx, dy);
      if (!mode) {
        setDragOverlay(null);
        return;
      }

      updateOverlay(start, mode, x, y);
    },
    [abortDrag, pointerPosition, updateHoverAt, updateOverlay]
  );

  const applyXRange = React.useCallback((plot: uPlot, startX: number, endX: number) => {
    const bounds = plotRect(plot, plotShellRef.current);
    const left = clamp(Math.min(startX, endX), bounds.left, bounds.left + bounds.width);
    const right = clamp(Math.max(startX, endX), bounds.left, bounds.left + bounds.width);

    if (right - left < dragThresholdPx) {
      return;
    }

    const startSeconds = plot.posToVal(left, "x");
    const endSeconds = plot.posToVal(right, "x");
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds === endSeconds) {
      return;
    }

    const center = (startSeconds + endSeconds) / 2;
    const halfWidth = Math.max((endSeconds - startSeconds) / 2, minHorizontalZoomSeconds / 2);
    latestRangeRef.current(
      new Date((center - halfWidth) * 1000),
      new Date((center + halfWidth) * 1000)
    );
  }, []);

  const applyYRange = React.useCallback((plot: uPlot, side: AxisSide, startY: number, endY: number) => {
    const sides: AxisSide[] =
      side === "left" && hasLeft
        ? ["left"]
        : side === "right" && hasRight
          ? ["right"]
          : [hasLeft ? "left" : null, hasRight ? "right" : null].filter(Boolean) as AxisSide[];
    const top = Math.min(startY, endY);
    const bottom = Math.max(startY, endY);
    const ranges: Partial<Record<AxisSide, ScaleRange>> = {};

    for (const nextSide of sides) {
      const first = plot.posToVal(bottom, nextSide);
      const second = plot.posToVal(top, nextSide);
      if (Number.isFinite(first) && Number.isFinite(second) && first !== second) {
        ranges[nextSide] = {
          max: Math.max(first, second),
          min: Math.min(first, second)
        };
      }
    }

    latestYRangeRef.current(ranges);
  }, [hasLeft, hasRight]);

  const completeDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      const plot = plotRef.current;
      dragStartRef.current = null;
      setDragOverlay(null);

      if (!start || !plot) {
        return;
      }

      if (event.pointerId !== start.pointerId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(start.pointerId)) {
        event.currentTarget.releasePointerCapture(start.pointerId);
      }

      const { x, y } = pointerPosition(event);
      const mode = dragModeFor(x - start.x, y - start.y);
      if (!mode) {
        if (event.ctrlKey && onMarkerCreate) {
          if (ctrlMarkerCreatedRef.current) {
            ctrlMarkerCreatedRef.current = false;
            return;
          }
          createMarkerAt(x);
          return;
        }

        if (activeMeasurementCursor) {
          setMeasurementCursorAt(x);
          return;
        }

        if (markerMode) {
          createMarkerAt(x);
          return;
        }

        const selection = nearestInteractionAt(x, y);
        if (selection) {
          latestPlotSelectRef.current?.(selection);
        }
        return;
      }

      if (mode === "x" || mode === "xy") {
        applyXRange(plot, start.x, x);
      }

      if (mode === "y" || mode === "xy") {
        applyYRange(plot, start.side, start.y, y);
      }
    },
    [
      activeMeasurementCursor,
      applyXRange,
      applyYRange,
      createMarkerAt,
      markerMode,
      nearestInteractionAt,
      onMarkerCreate,
      pointerPosition,
      setMeasurementCursorAt
    ]
  );

  const handlePointerCancel = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      abortDrag(event.currentTarget, event.pointerId);
    },
    [abortDrag]
  );

  const handleContextMenu = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || !onMarkerCreate) {
      return;
    }

    event.preventDefault();
    if (ctrlMarkerCreatedRef.current) {
      ctrlMarkerCreatedRef.current = false;
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    createMarkerAt(clamp(event.clientX - rect.left, 0, rect.width));
  }, [createMarkerAt, onMarkerCreate]);

  const handlePointerLeave = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (start) {
      if (!event.currentTarget.hasPointerCapture(start.pointerId)) {
        abortDrag(event.currentTarget, start.pointerId);
      }
      return;
    }

    setTooltip(null);
    latestCursorLeaveRef.current();
    latestPaneLeaveRef.current?.();
  }, [abortDrag]);

  return (
    <div
      className="uplot-lane"
      data-testid="uplot-lane"
      onDoubleClick={onResetZoom}
    >
      <div className="axis-gutter left" aria-hidden={!hasLeft} data-testid="axis-gutter-left">
        {hasLeft && <span className="axis-unit">{axisUnit(items, "left")}</span>}
        {axisTicks.left.map((tick) => (
          <span className="axis-tick" key={`${tick.label}-${tick.top}`} style={{ top: `${tick.top}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
      <div
        className="uplot-plot-shell"
        data-testid="plot-shell"
        onContextMenu={handleContextMenu}
        onLostPointerCapture={handlePointerCancel}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerLeave}
        onPointerMoveCapture={handlePointerMove}
        onPointerUp={completeDrag}
        ref={plotShellRef}
        tabIndex={-1}
      >
        {dragOverlay && (
          <span
            className={`chart-drag-overlay ${dragOverlay.mode}`}
            data-testid={`chart-drag-overlay-${dragOverlay.mode}`}
            style={{
              height: dragOverlay.height,
              left: dragOverlay.left,
              top: dragOverlay.top,
              width: dragOverlay.width
            }}
          />
        )}
        {markers.map((marker) => {
          if (marker.timestamp < xRange.min || marker.timestamp > xRange.max) {
            return null;
          }

          const left = ((marker.timestamp - xRange.min) / (xRange.max - xRange.min)) * 100;
          return (
            <span
              className="chart-marker"
              data-testid="chart-marker"
              key={marker.id}
              style={{ left: `${left}%` }}
            >
              <span className="chart-marker-line" style={{ background: marker.color }} />
              <span className="chart-marker-label">{marker.label}</span>
            </span>
          );
        })}
        {measurementCursors.map((cursor) => {
          if (cursor.timestamp === null || cursor.timestamp < xRange.min || cursor.timestamp > xRange.max) {
            return null;
          }

          const left = ((cursor.timestamp - xRange.min) / (xRange.max - xRange.min)) * 100;
          return (
            <span
              className={`measurement-cursor ${cursor.id.toLowerCase()}`}
              data-testid={`measurement-cursor-${cursor.id}`}
              key={cursor.id}
              style={{ left: `${left}%` }}
            >
              <span className="measurement-cursor-line" />
              <span className="measurement-cursor-label">{cursor.id}</span>
            </span>
          );
        })}
        {eventOverlays.map((eventOverlay) => {
          if (eventOverlay.timestamp < xRange.min || eventOverlay.timestamp > xRange.max) {
            return null;
          }

          const left = ((eventOverlay.timestamp - xRange.min) / (xRange.max - xRange.min)) * 100;
          return (
            <span
              className="event-overlay"
              data-testid="event-overlay"
              key={eventOverlay.id}
              style={{ left: `${left}%` }}
            >
              <span className="event-overlay-line" style={{ background: eventOverlay.color }} />
              <span className="event-overlay-label">{eventOverlay.label}</span>
            </span>
          );
        })}
        {tooltip && !dragOverlay && (
          <span
            className="cursor-tooltip"
            data-testid="cursor-tooltip"
            style={{
              left: tooltip.x,
              top: tooltip.y
            }}
          >
            <span className="swatch" style={{ background: tooltip.color }} />
            <span title={tooltip.signal}>{tooltip.signal}</span>
            <strong>{tooltip.label}</strong>
          </span>
        )}
      </div>
      <div className="axis-gutter right" aria-hidden={!hasRight} data-testid="axis-gutter-right">
        {hasRight && <span className="axis-unit">{axisUnit(items, "right")}</span>}
        {axisTicks.right.map((tick) => (
          <span className="axis-tick" key={`${tick.label}-${tick.top}`} style={{ top: `${tick.top}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}
