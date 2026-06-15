import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { save } from "@tauri-apps/plugin-dialog";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface DataFrame {
  timestamp: number;
  values: number[];
  raw: string;
}

interface WaveformPanelProps {
  frame: DataFrame | null;
}

interface CursorInfo {
  visible: boolean;
  time: number;
  values: Array<number | null>;
}

interface SampleInfo {
  time: number | null;
  values: Array<number | null>;
}

interface PanState {
  startX: number;
  startY: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

const CHANNEL_COLORS = [
  "#FF5252",
  "#448AFF",
  "#69F0AE",
  "#FFD740",
  "#E040FB",
  "#40C4FF",
  "#FF6E40",
  "#B2FF59",
];

function fmtTime(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "--:--.---";
  const totalSec = Math.max(0, Math.floor(v));
  const ms = Math.floor((v - totalSec) * 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function fmtValue(v: number | null): string {
  return v == null || Number.isNaN(v) ? "--" : v.toFixed(3);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

type ViewMode = "auto" | "browse";

export function WaveformPanel({ frame }: WaveformPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  const [channelCount, setChannelCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("auto");
  const [cursorInfo, setCursorInfo] = useState<CursorInfo>({
    visible: false,
    time: 0,
    values: [],
  });
  const [clearedUntilTimestamp, setClearedUntilTimestamp] = useState<number>(Number.POSITIVE_INFINITY);

  // 备注：可调波形参数
  const [deltaT, setDeltaT] = useState(50);          // △t 采样间隔 ms
  const [bufferLimit, setBufferLimit] = useState(50000); // 缓冲区上限 /ch
  const [autoPoints, setAutoPoints] = useState(100);   // Auto 点数对齐

  const pausedRef = useRef(false);
  const panningRef = useRef(false);
  const viewModeRef = useRef<ViewMode>("auto");
  const panStateRef = useRef<PanState | null>(null);

  const bufferRef = useRef<{ timestamps: number[]; channels: number[][] }>({
    timestamps: [],
    channels: [],
  });

  const latestSample: SampleInfo =
    frame && frame.timestamp > clearedUntilTimestamp
      ? {
          time: frame.timestamp,
          values: frame.values.map((value) => value ?? null),
        }
      : {
          time: null,
          values: [],
        };

  const buildAlignedData = useCallback((): uPlot.AlignedData => {
    const { timestamps, channels } = bufferRef.current;
    return [
      new Float64Array(timestamps),
      ...channels.map((channel) => new Float64Array(channel)),
    ];
  }, []);

  const renderChart = useCallback((resetScales: boolean) => {
    const chart = chartRef.current;
    if (!chart || bufferRef.current.channels.length === 0) return;

    chart.setData(buildAlignedData(), resetScales);
  }, [buildAlignedData]);

  const resetToLatest = useCallback(() => {
    viewModeRef.current = "auto";
    setViewMode("auto");
    renderChart(true);
  }, [renderChart]);

  const exportCsv = useCallback(async () => {
    const { timestamps, channels } = bufferRef.current;
    if (timestamps.length === 0) return;

    const headers = ["timestamp", ...channels.map((_, index) => `CH${index + 1}`)];
    const rows = timestamps.map((timestamp, rowIndex) => {
      const values = channels.map((channel) => channel[rowIndex] ?? "");
      return [timestamp.toFixed(6), ...values].join(",");
    });

    const csv = [headers.join(","), ...rows].join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = await save({
      defaultPath: `waveform-${stamp}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });

    if (!filePath) return;

    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(filePath, csv);
  }, []);

  const initChart = useCallback((numChannels: number) => {
    const el = containerRef.current;
    if (!el) return;

    chartRef.current?.destroy();
    chartRef.current = null;

    const width = el.clientWidth;
    const height = el.clientHeight || 360;
    if (width === 0 || height === 0) return;

    const style = getComputedStyle(document.documentElement);
    const gridColor = style.getPropertyValue("--border").trim() || "#30363d";
    const textColor = style.getPropertyValue("--text-muted").trim() || "#6e7681";

    const series: uPlot.Series[] = [
      {
        label: "时间",
        value: (_u, v) => fmtTime(v),
      },
    ];

    for (let index = 0; index < numChannels; index++) {
      series.push({
        label: `CH${index + 1}`,
        stroke: CHANNEL_COLORS[index % CHANNEL_COLORS.length],
        width: 1.5,
        points: { show: false },
        value: (_u, v) => fmtValue(v),
      });
    }

    chartRef.current = new uPlot(
      {
        width,
        height,
        series,
        axes: [
          {
            stroke: textColor,
            grid: { stroke: gridColor, width: 1 },
            values: (_u, vals) => vals.map((value) => fmtTime(value)),
            size: 54,
            gap: 6,
          },
          {
            stroke: textColor,
            grid: { stroke: gridColor, width: 1 },
            size: 52,
          },
        ],
        cursor: {
          drag: { x: false, y: false, setScale: false },
          points: { show: false },
        },
        scales: {
          x: { time: false, auto: true },
          y: { auto: true },
        },
        hooks: {
          setCursor: [
            (plot) => {
              const { left, top } = plot.cursor;
              if (left == null || top == null || left < 0 || top < 0) {
                setCursorInfo((prev) => (prev.visible ? { ...prev, visible: false } : prev));
                return;
              }

              const { timestamps, channels } = bufferRef.current;
              if (timestamps.length === 0) return;

              const dataIndex = clampIndex(Math.round(plot.posToIdx(left)), timestamps.length);
              setCursorInfo({
                visible: true,
                time: timestamps[dataIndex],
                values: channels.map((channel) => channel[dataIndex] ?? null),
              });
            },
          ],
          setScale: [
            (plot, key) => {
              const scale = plot.scales[key];
              if (scale.min == null || scale.max == null) return;
            },
          ],
        },
      },
      [new Float64Array(0), ...Array.from({ length: numChannels }, () => new Float64Array(0))],
      el,
    );

    setChannelCount(numChannels);

    if (bufferRef.current.timestamps.length > 0) {
      renderChart(true);
    }
  }, [renderChart]);

  useEffect(() => {
    if (!frame) return;

    const numChannels = frame.values.length;
    if (numChannels === 0) return;

    if (bufferRef.current.channels.length === 0) {
      bufferRef.current.channels = Array.from({ length: numChannels }, () => []);
      setChannelCount(numChannels);
    } else if (bufferRef.current.channels.length !== numChannels) {
      bufferRef.current = {
        timestamps: [],
        channels: Array.from({ length: numChannels }, () => []),
      };
      setCursorInfo({ visible: false, time: 0, values: [] });
      initChart(numChannels);
    }

    if (!chartRef.current) {
      initChart(numChannels);
    }

    const { timestamps, channels } = bufferRef.current;
    timestamps.push(frame.timestamp);
    for (let index = 0; index < channels.length; index++) {
      channels[index].push(frame.values[index] ?? 0);
    }

    while (timestamps.length > bufferLimit) {
      timestamps.shift();
      for (const channel of channels) {
        channel.shift();
      }
    }

    if (!pausedRef.current && !panningRef.current && viewModeRef.current === "auto") {
      renderChart(true);
    }
  }, [frame, bufferLimit, initChart, renderChart]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const resizeChart = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      if (chartRef.current && width > 0 && height > 0) {
        chartRef.current.setSize({ width, height });
      } else if (!chartRef.current && width > 0 && height > 0 && bufferRef.current.channels.length > 0) {
        initChart(bufferRef.current.channels.length);
      }
    };

    const observer = new ResizeObserver(() => resizeChart());
    observer.observe(el);
    window.addEventListener("resize", resizeChart);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeChart);
    };
  }, [initChart]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!panningRef.current) return;

      const chart = chartRef.current;
      const el = containerRef.current;
      const panState = panStateRef.current;
      if (!chart || !el || !panState) return;

      const xRange = panState.xMax - panState.xMin;
      const yRange = panState.yMax - panState.yMin;
      if (xRange <= 0 || yRange <= 0) return;

      const dx = event.clientX - panState.startX;
      const dy = event.clientY - panState.startY;
      const dataDx = -(dx / el.clientWidth) * xRange;
      const dataDy = (dy / el.clientHeight) * yRange;

      chart.batch(() => {
        chart.setScale("x", {
          min: panState.xMin + dataDx,
          max: panState.xMax + dataDx,
        });
        chart.setScale("y", {
          min: panState.yMin + dataDy,
          max: panState.yMax + dataDy,
        });
      });
    };

    const handleMouseUp = () => {
      if (!panningRef.current) return;

      panningRef.current = false;
      panStateRef.current = null;

      const el = containerRef.current;
      if (el) {
        el.style.cursor = "";
      }

      if (!pausedRef.current && viewModeRef.current === "auto") {
        renderChart(true);
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [renderChart]);

  useEffect(() => {
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  const handleTogglePause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);

    if (!next) {
      resetToLatest();
    }
  };

  const handleAuto = () => {
    pausedRef.current = false;
    setPaused(false);
    resetToLatest();
  };

  const handleClear = () => {
    bufferRef.current = {
      timestamps: [],
      channels: Array.from({ length: channelCount }, () => []),
    };
    setCursorInfo({ visible: false, time: 0, values: [] });
    setClearedUntilTimestamp(frame?.timestamp ?? Number.POSITIVE_INFINITY);
    chartRef.current?.setData(
      [new Float64Array(0), ...Array.from({ length: channelCount }, () => new Float64Array(0))],
      true,
    );
  };

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const chart = chartRef.current;
    const el = containerRef.current;
    if (!chart || !el || bufferRef.current.timestamps.length === 0) return;

    event.preventDefault();
    if (viewModeRef.current !== "browse") {
      viewModeRef.current = "browse";
      setViewMode("browse");
    }

    const isVerticalOnly = event.shiftKey;
    const rect = el.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const zoomIn = event.deltaY < 0;
    const factor = zoomIn ? 0.82 : 1.22;

    const batchUpdate = () => {
      if (!isVerticalOnly) {
        const xScale = chart.scales.x;
        const xMin = xScale.min ?? 0;
        const xMax = xScale.max ?? 1;
        const xRange = xMax - xMin;
        if (xRange > 0) {
          const xCenter = chart.posToVal(mouseX, "x");
          const xRatio = (xCenter - xMin) / xRange;
          const nextRange = xRange * factor;
          chart.setScale("x", {
            min: xCenter - nextRange * xRatio,
            max: xCenter + nextRange * (1 - xRatio),
          });
        }
      }

      const yScale = chart.scales.y;
      const yMin = yScale.min ?? 0;
      const yMax = yScale.max ?? 1;
      const yRange = yMax - yMin;
      if (yRange > 0) {
        const yCenter = chart.posToVal(mouseY, "y");
        const yRatio = (yCenter - yMin) / yRange;
        const nextRange = yRange * factor;
        chart.setScale("y", {
          min: yCenter - nextRange * yRatio,
          max: yCenter + nextRange * (1 - yRatio),
        });
      }
    };

    chart.batch(batchUpdate);
  }, []);

  const handleMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const chart = chartRef.current;
    const el = containerRef.current;
    if (!chart || !el) return;

    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    const xMin = xScale.min;
    const xMax = xScale.max;
    const yMin = yScale.min;
    const yMax = yScale.max;

    if (xMin == null || xMax == null || yMin == null || yMax == null) return;

    if (viewModeRef.current !== "browse") {
      viewModeRef.current = "browse";
      setViewMode("browse");
    }
    panningRef.current = true;
    panStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      xMin,
      xMax,
      yMin,
      yMax,
    };
    el.style.cursor = "grabbing";
  }, []);

  const cursorText = cursorInfo.visible
    ? `T ${fmtTime(cursorInfo.time)} | ${cursorInfo.values.map((value, index) => `CH${index + 1} ${fmtValue(value)}`).join("  ")}`
    : latestSample.time != null
      ? `Latest ${fmtTime(latestSample.time)} | ${latestSample.values.map((value, index) => `CH${index + 1} ${fmtValue(value)}`).join("  ")}`
      : "等待数据...";

  return (
    <div className="waveform-panel">
      <div className="waveform-toolbar">
        <span className="waveform-title">波形</span>
        <span className="waveform-channels">
          {channelCount > 0 ? `${channelCount} CH | ${cursorText}` : "等待数据..."}
        </span>
        <button className={`btn-small ${paused ? "btn-resume" : "btn-pause"}`} onClick={handleTogglePause}>
          {paused ? "▶ 继续" : "⏸ 暂停"}
        </button>
        <button className={`btn-small ${viewMode === "auto" ? "btn-active" : ""}`} onClick={handleAuto}>Auto</button>
        <button className="btn-small" onClick={() => void exportCsv()}>CSV</button>
        <button className="btn-small btn-clear" onClick={handleClear}>✕</button>
      </div>
      <div
        className="waveform-container"
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onWheel={handleWheel}
      />
      {/* 备注：状态栏 - 可调参数 */}
      <div className="waveform-statusbar">
        <label className="statusbar-item">
          △t:
          <input
            type="number"
            min={1}
            value={deltaT}
            onChange={(e) => setDeltaT(Math.max(1, Number(e.target.value)))}
            className="statusbar-input"
          />
          ms
        </label>
        <label className="statusbar-item">
          缓冲区上限:
          <input
            type="number"
            min={1000}
            step={1000}
            value={bufferLimit}
            onChange={(e) => setBufferLimit(Math.max(1000, Number(e.target.value)))}
            className="statusbar-input"
          />
          /ch
        </label>
        <label className="statusbar-item">
          Auto点数对齐:
          <input
            type="number"
            min={10}
            value={autoPoints}
            onChange={(e) => setAutoPoints(Math.max(10, Number(e.target.value)))}
            className="statusbar-input"
          />
        </label>
      </div>
    </div>
  );
}
