import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  const [channelCount, setChannelCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("auto");
  // 备注：cursorInfo 通过 ref 直接操作 DOM，避免鼠标移动触发 re-render
  const cursorTextRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [clearedUntilTimestamp, setClearedUntilTimestamp] = useState<number>(0);
  const [hiddenChannels, setHiddenChannels] = useState<Record<number, boolean>>({});
  const hiddenChannelsRef = useRef(hiddenChannels);
  useEffect(() => { hiddenChannelsRef.current = hiddenChannels; }, [hiddenChannels]);

  const toggleChannelVisibility = useCallback((chIdx: number) => {
    setHiddenChannels((prev) => ({
      ...prev,
      [chIdx]: !prev[chIdx],
    }));
  }, []);

  // 备注：可调波形参数
  const [bufferLimit, setBufferLimit] = useState(50000); // 缓冲区上限 /ch

  const pausedRef = useRef(false);
  const panningRef = useRef(false);
  const viewModeRef = useRef<ViewMode>("auto");
  const panStateRef = useRef<PanState | null>(null);

  // 备注：可调波形参数
  const [deltaT, setDeltaT] = useState(50);
  const [autoPoints, setAutoPoints] = useState(100);

  // Right sidebar drag to resize width state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem("waveform-sidebar-width");
      return saved ? Number(saved) : 200;
    } catch {
      return 200;
    }
  });

  useEffect(() => {
    localStorage.setItem("waveform-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  const handleResizerMouseDown = useCallback((mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    const startX = mouseDownEvent.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Dragging left (reducing ClientX) increases the right sidebar's width.
      const deltaX = startX - moveEvent.clientX;
      const nextWidth = Math.max(120, Math.min(400, startWidth + deltaX));
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [sidebarWidth]);

  const bufferRef = useRef<{ timestamps: number[]; channels: number[][] }>({
    timestamps: [],
    channels: [],
  });

  // 备注：rAF 合并多帧为单次渲染
  const rafIdRef = useRef(0);

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

  // 备注：预分配 Float64Array 池，避免每帧分配新数组
  const dataPoolRef = useRef<Float64Array[]>([]);

  const buildAlignedData = useCallback((): uPlot.AlignedData => {
    const { timestamps, channels } = bufferRef.current;
    const needed = channels.length + 1;

    // 备注：确保池大小正确
    while (dataPoolRef.current.length < needed) {
      dataPoolRef.current.push(new Float64Array(0));
    }

    // 备注：复制时间轴
    const tsArr = new Float64Array(timestamps);
    dataPoolRef.current[0] = tsArr;

    // 备注：复制各通道数据
    for (let i = 0; i < channels.length; i++) {
      dataPoolRef.current[i + 1] = new Float64Array(channels[i]);
    }

    return dataPoolRef.current.slice(0, needed);
  }, []);

  const renderChart = useCallback((resetScales: boolean) => {
    const chart = chartRef.current;
    if (!chart || bufferRef.current.channels.length === 0) return;

    const data = buildAlignedData();
    chart.setData(data, resetScales);

    // 备注：autoPoints 生效 — Auto 模式下只显示最后 N 个点
    if (viewModeRef.current === "auto" && data[0].length > autoPoints) {
      const xMax = data[0][data[0].length - 1];
      const xMin = data[0][data[0].length - autoPoints];
      chart.setScale("x", { min: xMin, max: xMax });
    }
  }, [buildAlignedData, autoPoints]);

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
        label: t("waveform.time", { defaultValue: "时间" }),
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
        show: !hiddenChannels[index],
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
                // 备注：直接操作 DOM，不触发 re-render
                if (tooltipRef.current) {
                  tooltipRef.current.style.display = "none";
                }
                if (cursorTextRef.current) {
                  const { timestamps, channels } = bufferRef.current;
                  if (timestamps.length > 0) {
                    const last = timestamps.length - 1;
                    cursorTextRef.current.textContent =
                      `${fmtTime(timestamps[last])} | ${channels.map((ch, i) => `CH${i + 1} ${fmtValue(ch[last] ?? null)}`).join("  ")}`;
                  } else {
                    cursorTextRef.current.textContent = t("waveform.waiting", { defaultValue: "等待数据..." });
                  }
                }
                return;
              }

              const { timestamps, channels } = bufferRef.current;
              if (timestamps.length === 0) return;

              const dataIndex = clampIndex(Math.round(plot.posToIdx(left)), timestamps.length);

              // 计算 y 轴方向上距离鼠标最近的可见通道
              let minDistance = Number.POSITIVE_INFINITY;
              let closestChIdx = -1;

              for (let i = 0; i < channels.length; i++) {
                if (hiddenChannelsRef.current[i]) continue;
                const val = channels[i][dataIndex];
                if (val === undefined || val === null || Number.isNaN(val)) continue;

                const yPos = plot.valToPos(val, "y");
                if (yPos != null) {
                  const dist = Math.abs(top - yPos);
                  if (dist < minDistance) {
                    minDistance = dist;
                    closestChIdx = i;
                  }
                }
              }

              // 准备最近通道的文本信息
              let closestText = "";
              let closestHtml = "";
              let chColor = "";
              if (closestChIdx !== -1) {
                const val = channels[closestChIdx][dataIndex] ?? null;
                chColor = CHANNEL_COLORS[closestChIdx % CHANNEL_COLORS.length];
                closestText = `最近: CH${closestChIdx + 1} (X: ${fmtTime(timestamps[dataIndex])}, Y: ${fmtValue(val)}) | `;
                closestHtml = `
                  <div class="tooltip-ch" style="color: ${chColor}">CH${closestChIdx + 1}</div>
                  <div class="tooltip-coord">X: ${fmtTime(timestamps[dataIndex])}</div>
                  <div class="tooltip-coord">Y: ${fmtValue(val)}</div>
                `;
              }

              // 更新顶部文本
              if (cursorTextRef.current) {
                cursorTextRef.current.textContent =
                  `${closestText}T ${fmtTime(timestamps[dataIndex])} | ${channels.map((ch, i) => `CH${i + 1} ${fmtValue(ch[dataIndex] ?? null)}`).join("  ")}`;
              }

              // 更新并显示 HTML 悬浮框 tooltip
              const el = containerRef.current;
              if (tooltipRef.current && el && closestChIdx !== -1) {
                let tooltipX = left + plot.bbox.left + 15;
                let tooltipY = top + plot.bbox.top + 15;
                const containerWidth = el.clientWidth;
                const containerHeight = el.clientHeight;

                // 边界检测，防溢出
                if (tooltipX + 130 > containerWidth) {
                  tooltipX = left + plot.bbox.left - 145;
                }
                if (tooltipY + 70 > containerHeight) {
                  tooltipY = top + plot.bbox.top - 75;
                }

                tooltipRef.current.style.display = "block";
                tooltipRef.current.style.left = `${tooltipX}px`;
                tooltipRef.current.style.top = `${tooltipY}px`;
                tooltipRef.current.innerHTML = closestHtml;
              } else if (tooltipRef.current) {
                tooltipRef.current.style.display = "none";
              }
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
  }, [renderChart, hiddenChannels, t]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (let index = 0; index < channelCount; index++) {
      const isShow = !hiddenChannels[index];
      if (chart.series[index + 1]) {
        chart.setSeries(index + 1, { show: isShow });
      }
    }
  }, [hiddenChannels, channelCount]);

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
      setHiddenChannels({}); // P0 #3: 通道数变化时重置隐藏状态
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
      // 备注：用 splice 批量淘汰，替代逐个 shift (O(n) → O(n) 但只调一次)
      const excess = timestamps.length - bufferLimit;
      timestamps.splice(0, excess);
      for (const channel of channels) {
        channel.splice(0, excess);
      }
    }

    if (!pausedRef.current && !panningRef.current && viewModeRef.current === "auto") {
      // 备注：用 rAF 合并同帧内的多次数据更新为一次渲染
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        renderChart(true);
      });
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
      cancelAnimationFrame(rafIdRef.current);
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
    if (cursorTextRef.current) {
      cursorTextRef.current.textContent = t("waveform.waiting", { defaultValue: "等待数据..." });
    }
    setClearedUntilTimestamp(frame?.timestamp ?? 0);
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

  const defaultCursorText = latestSample.time != null
    ? `Latest ${fmtTime(latestSample.time)} | ${latestSample.values.map((value, index) => `CH${index + 1} ${fmtValue(value)}`).join("  ")}`
    : t("waveform.waiting", { defaultValue: "等待数据..." });

  return (
    <div className="waveform-layout">
      <div className="waveform-panel">
        <div className="waveform-toolbar">
          <span className="waveform-title">{t("waveform.title", { defaultValue: "波形" })}</span>
          <span className="waveform-channels">
            {channelCount > 0 ? <>{channelCount} CH | <span ref={cursorTextRef}>{defaultCursorText}</span></> : t("waveform.waiting", { defaultValue: "等待数据..." })}
          </span>
          <button className={`btn-small ${paused ? "btn-resume" : "btn-pause"}`} onClick={handleTogglePause}>
            {paused ? `▶ ${t("waveform.resume", { defaultValue: "继续" })}` : `⏸ ${t("waveform.pause", { defaultValue: "暂停" })}`}
          </button>
          <button className={`btn-small ${viewMode === "auto" ? "btn-active" : ""}`} onClick={handleAuto}>{t("waveform.auto", { defaultValue: "Auto" })}</button>
          <button className="btn-small" onClick={() => void exportCsv()}>{t("waveform.csv", { defaultValue: "CSV" })}</button>
          <button className="btn-small btn-clear" onClick={handleClear}>✕</button>
        </div>
        <div
          className="waveform-container"
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onWheel={handleWheel}
        >
          <div ref={tooltipRef} className="waveform-tooltip" style={{ display: "none", position: "absolute", pointerEvents: "none", zIndex: 10 }} />
        </div>
        {/* 备注：状态栏 - 可调参数 */}
        <div className="waveform-statusbar">
          <label className="statusbar-item">
            {t("waveform.deltaT", { defaultValue: "△t" })}:
            <input
              type="number"
              min={1}
              value={deltaT}
              onChange={(e) => setDeltaT(Math.max(1, Number(e.target.value)))}
              className="statusbar-input"
            />
            ms
            <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>
              ({(1000 / deltaT).toFixed(1)} Hz)
            </span>
          </label>
          <label className="statusbar-item">
            {t("waveform.bufferLimit", { defaultValue: "缓冲区上限" })}:
            <input
              type="number"
              min={1000}
              step={1000}
              value={bufferLimit}
              onChange={(e) => setBufferLimit(Math.max(1000, Number(e.target.value)))}
              className="statusbar-input"
            />
            {t("waveform.perChannel", { defaultValue: "/ch" })}
          </label>
          <label className="statusbar-item">
            {t("waveform.autoPoints", { defaultValue: "Auto点数对齐" })}:
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

      <div className="waveform-sidebar-resizer" onMouseDown={handleResizerMouseDown} />

      <aside className="waveform-sidebar" style={{ width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px` }}>
        <div className="waveform-sidebar-header">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
          <span>{t("waveform.sidebarData", { defaultValue: "数据" })}</span>
        </div>
        <div className="waveform-sidebar-list">
          {Array.from({ length: channelCount }).map((_, index) => {
            const isHidden = !!hiddenChannels[index];
            const color = CHANNEL_COLORS[index % CHANNEL_COLORS.length];
            const val = frame ? (frame.values[index] ?? null) : null;
            return (
              <div key={index} className={`waveform-sidebar-item ${isHidden ? "hidden" : ""}`}>
                <button
                  className="btn-visibility"
                  onClick={() => toggleChannelVisibility(index)}
                  title={isHidden ? "显示通道" : "屏蔽通道"}
                >
                  {isHidden ? (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                      <line x1="1" y1="1" x2="23" y2="23"></line>
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                      <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                  )}
                </button>
                <span className="channel-name" style={{ color: isHidden ? "var(--text-muted)" : color }}>
                  CH{index + 1}
                </span>
                <span className="channel-value" style={{ color: isHidden ? "var(--text-muted)" : color }}>
                  {fmtValue(val)}
                </span>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
