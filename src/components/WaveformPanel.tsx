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
import { listen } from "@tauri-apps/api/event";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface DataFrame {
  timestamp: number;
  values: number[];
  raw: string;
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

function downsampleData(
  timestamps: number[],
  channels: (number | null)[][],
  targetPoints: number = 2000
): uPlot.AlignedData {
  const total = timestamps.length;
  if (total <= targetPoints || total === 0) {
    return [timestamps, ...channels] as any;
  }

  const numChannels = channels.length;
  const bucketSize = Math.floor(total / (targetPoints / 2));
  if (bucketSize <= 1) {
    return [timestamps, ...channels] as any;
  }

  const downsampledTimestamps: number[] = [];
  const downsampledChannels: (number | null)[][] = Array.from({ length: numChannels }, () => []);

  for (let i = 0; i < total; i += bucketSize) {
    const end = Math.min(i + bucketSize, total);

    const ch0 = channels[0];
    let minIdx = i;
    let maxIdx = i;

    if (ch0) {
      let minVal = ch0[i] ?? 0;
      let maxVal = minVal;
      for (let j = i + 1; j < end; j++) {
        const v = ch0[j] ?? 0;
        if (v < minVal) {
          minVal = v;
          minIdx = j;
        }
        if (v > maxVal) {
          maxVal = v;
          maxIdx = j;
        }
      }
    } else {
      minIdx = i;
      maxIdx = Math.min(i + 1, end - 1);
    }

    const idxs = minIdx === maxIdx ? [minIdx] : (minIdx < maxIdx ? [minIdx, maxIdx] : [maxIdx, minIdx]);

    for (const idx of idxs) {
      downsampledTimestamps.push(timestamps[idx]);
      for (let ch = 0; ch < numChannels; ch++) {
        downsampledChannels[ch].push(channels[ch][idx]);
      }
    }
  }

  return [downsampledTimestamps, ...downsampledChannels] as any;
}

export function WaveformPanel({ theme }: { theme: string }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  const [channelCount, setChannelCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("auto");
  // 备注：cursorInfo 通过 ref 直接操作 DOM，避免鼠标移动触发 re-render
  const cursorTextRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
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

  const [downsampleEnabled, setDownsampleEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("waveform-downsample");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    localStorage.setItem("waveform-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("waveform-downsample", String(downsampleEnabled));
  }, [downsampleEnabled]);

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

  const bufferRef = useRef<{ timestamps: number[]; channels: (number | null)[][] }>({
    timestamps: [],
    channels: [],
  });

  // 备注：rAF 合并多帧为单次渲染
  const rafIdRef = useRef(0);
  const renderTimeoutRef = useRef<any>(null);
  const lastRenderTimeRef = useRef(0);

  // VOFA+ 样式滚动条/信息栏 refs
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const totalPointsValRef = useRef<HTMLSpanElement>(null);
  const visiblePointsValRef = useRef<HTMLSpanElement>(null);
  const timeDivValRef = useRef<HTMLSpanElement>(null);
  const cursorDotRef = useRef<HTMLDivElement>(null);
  const scrollbarTooltipRef = useRef<HTMLDivElement>(null);



  const buildAlignedData = useCallback((): uPlot.AlignedData => {
    const { timestamps, channels } = bufferRef.current;
    if (downsampleEnabled) {
      return downsampleData(timestamps, channels);
    }
    return [timestamps, ...channels] as any;
  }, [downsampleEnabled]);

  const updateScrollbarAndInfo = useCallback((plot: uPlot) => {
    const track = scrollbarTrackRef.current;
    const thumb = scrollbarThumbRef.current;
    if (!track || !thumb) return;

    const { timestamps } = bufferRef.current;
    const total = timestamps.length;

    if (totalPointsValRef.current) {
      totalPointsValRef.current.textContent = `${total} / ${bufferLimit}`;
      const parentItem = totalPointsValRef.current.closest(".info-item");
      if (parentItem) {
        parentItem.setAttribute("title", `当前缓冲区有效数据: ${total}/ch`);
      }
    }

    if (total === 0) {
      thumb.style.width = "100%";
      thumb.style.left = "0px";
      if (visiblePointsValRef.current) visiblePointsValRef.current.textContent = "0";
      if (timeDivValRef.current) timeDivValRef.current.textContent = "--/X-div";
      return;
    }

    const xScale = plot.scales.x;
    if (xScale.min == null || xScale.max == null) return;

    // 二分搜索查找可视区域索引范围
    let idxMin = 0;
    let idxMax = total - 1;

    let low = 0, high = total - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timestamps[mid] >= xScale.min) {
        idxMin = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    low = 0;
    high = total - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timestamps[mid] <= xScale.max) {
        idxMax = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const visibleCount = Math.max(0, idxMax - idxMin + 1);
    if (visiblePointsValRef.current) {
      visiblePointsValRef.current.textContent = String(visibleCount);
      const parentItem = visiblePointsValRef.current.closest(".info-item");
      if (parentItem) {
        parentItem.setAttribute("title", `当前屏幕可视区域数据点数: ${visibleCount}`);
      }
    }

    const visibleDuration = xScale.max - xScale.min;
    const timeDiv = visibleDuration / 10;
    let timeDivText = "";
    if (timeDiv < 1) {
      timeDivText = `${(timeDiv * 1000).toFixed(0)}ms/X-div`;
    } else {
      timeDivText = `${timeDiv.toFixed(2)}s/X-div`;
    }
    if (timeDivValRef.current) {
      timeDivValRef.current.textContent = timeDivText;
      const parentItem = timeDivValRef.current.closest(".info-item");
      if (parentItem) {
        parentItem.setAttribute("title", `时间轴网格间距分度值: ${timeDivText}`);
      }
    }

    const trackWidth = track.clientWidth;
    if (trackWidth === 0) return;

    const leftRatio = total > 1 ? idxMin / (total - 1) : 0;
    const rightRatio = total > 1 ? idxMax / (total - 1) : 1;

    let thumbLeft = leftRatio * trackWidth;
    let thumbWidth = (rightRatio - leftRatio) * trackWidth;

    if (thumbWidth < 12) {
      thumbWidth = 12;
      if (rightRatio > 0.99) {
        thumbLeft = trackWidth - thumbWidth;
      }
    }

    thumbLeft = Math.max(0, Math.min(trackWidth - thumbWidth, thumbLeft));

    thumb.style.left = `${thumbLeft}px`;
    thumb.style.width = `${thumbWidth}px`;

    // Dynamic Scrollbar Tooltip Content Update
    if (scrollbarTooltipRef.current) {
      const duration = timestamps[idxMax] - timestamps[idxMin];
      const durationMs = (duration * 1000).toFixed(0);
      scrollbarTooltipRef.current.innerHTML = `
        <div class="sb-tooltip-row"><strong>可视采样点:</strong> <span>[${idxMin}, ${idxMax}]</span></div>
        <div class="sb-tooltip-row"><strong>可视点数量:</strong> <span>${visibleCount}/ch</span></div>
        <div class="sb-tooltip-row"><strong>时间段长度:</strong> <span>${durationMs}ms</span></div>
      `;
    }
  }, [bufferLimit]);

  const renderChart = useCallback((resetScales: boolean) => {
    const chart = chartRef.current;
    if (!chart || bufferRef.current.channels.length === 0) return;

    const data = buildAlignedData();
    chart.setData(data, resetScales);

    const { timestamps, channels } = bufferRef.current;
    const lastIdx = timestamps.length - 1;

    if (data[0].length > 0) {
      if (viewModeRef.current === "auto") {
        const rawSpan = data[0].length > autoPoints
          ? data[0][data[0].length - 1] - data[0][data[0].length - autoPoints]
          : autoPoints * (deltaT / 1000);
        const visibleSpan = rawSpan / 0.9; // 10% 右边距
        const latestTime = data[0][data[0].length - 1];
        const xMax = latestTime + visibleSpan * 0.1;
        const xMin = latestTime - visibleSpan * 0.9;
        chart.setScale("x", { min: xMin, max: xMax });
      }
    }

    // 1. If cursor is not active, update the top bar with the latest value directly
    const cursor = chart.cursor;
    const isCursorActive = cursor && cursor.left != null && cursor.left >= 0 && cursor.top != null && cursor.top >= 0;
    if (!isCursorActive && cursorTextRef.current) {
      if (lastIdx >= 0) {
        cursorTextRef.current.textContent =
          `Latest ${fmtTime(timestamps[lastIdx])} | ${channels.map((ch, i) => `CH${i + 1} ${fmtValue(ch[lastIdx] ?? null)}`).join("  ")}`;
      } else {
        cursorTextRef.current.textContent = t("waveform.waiting", { defaultValue: "等待数据..." });
      }
    }

    // 2. Update sidebar channel values directly via DOM query
    const valSpans = containerRef.current?.closest(".waveform-layout")?.querySelectorAll(".channel-value");
    if (valSpans) {
      valSpans.forEach((span) => {
        const idxAttr = span.getAttribute("data-ch-idx");
        if (idxAttr !== null) {
          const index = Number(idxAttr);
          const val = lastIdx >= 0 ? (channels[index]?.[lastIdx] ?? null) : null;
          span.textContent = fmtValue(val);
        }
      });
    }

    updateScrollbarAndInfo(chart);
  }, [buildAlignedData, autoPoints, deltaT, updateScrollbarAndInfo, t]);

  const resetToLatest = useCallback(() => {
    viewModeRef.current = "auto";
    setViewMode("auto");
    if (chartRef.current) {
      chartRef.current.setScale("x", { min: null as any, max: null as any });
      chartRef.current.setScale("y", { min: null as any, max: null as any });
    }
    renderChart(false);
  }, [renderChart]);

  const handleScrollbarThumbMouseDown = useCallback((mouseDownEvent: ReactMouseEvent<HTMLDivElement>) => {
    mouseDownEvent.preventDefault();
    const chart = chartRef.current;
    const track = scrollbarTrackRef.current;
    const thumb = scrollbarThumbRef.current;
    if (!chart || !track || !thumb) return;

    const { timestamps } = bufferRef.current;
    const total = timestamps.length;
    if (total === 0) return;

    const trackWidth = track.clientWidth;
    if (trackWidth === 0) return;

    const startX = mouseDownEvent.clientX;
    const startLeft = thumb.offsetLeft;
    const currentThumbWidth = thumb.offsetWidth;

    const xScale = chart.scales.x;
    if (xScale.min == null || xScale.max == null) return;

    let idxMin = 0;
    let idxMax = total - 1;
    let low = 0, high = total - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timestamps[mid] >= xScale.min) {
        idxMin = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    low = 0;
    high = total - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timestamps[mid] <= xScale.max) {
        idxMax = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const visibleCount = idxMax - idxMin + 1;

    if (viewModeRef.current !== "browse") {
      viewModeRef.current = "browse";
      setViewMode("browse");
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      let nextLeft = Math.max(0, Math.min(trackWidth - currentThumbWidth, startLeft + deltaX));

      const leftRatio = nextLeft / trackWidth;
      const rightRatio = (nextLeft + currentThumbWidth) / trackWidth;

      let targetStartIdx = Math.round(leftRatio * (total - 1));
      let targetEndIdx = Math.round(rightRatio * (total - 1));

      targetEndIdx = Math.min(total - 1, targetStartIdx + visibleCount - 1);
      targetStartIdx = Math.max(0, targetEndIdx - visibleCount + 1);

      if (targetStartIdx >= 0 && targetEndIdx < total) {
        chart.setScale("x", {
          min: timestamps[targetStartIdx],
          max: timestamps[targetEndIdx],
        });
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  const handleScrollbarTrackMouseDown = useCallback((mouseDownEvent: ReactMouseEvent<HTMLDivElement>) => {
    if (mouseDownEvent.target === scrollbarThumbRef.current) return;

    const chart = chartRef.current;
    const track = scrollbarTrackRef.current;
    const thumb = scrollbarThumbRef.current;
    if (!chart || !track || !thumb) return;

    const { timestamps } = bufferRef.current;
    const total = timestamps.length;
    if (total === 0) return;

    const rect = track.getBoundingClientRect();
    const clickX = mouseDownEvent.clientX - rect.left;
    const trackWidth = track.clientWidth;
    const currentThumbWidth = thumb.offsetWidth;

    let targetLeft = clickX - currentThumbWidth / 2;
    targetLeft = Math.max(0, Math.min(trackWidth - currentThumbWidth, targetLeft));

    const xScale = chart.scales.x;
    if (xScale.min == null || xScale.max == null) return;

    let idxMin = 0;
    let idxMax = total - 1;
    let low = 0, high = total - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timestamps[mid] >= xScale.min) {
        idxMin = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    low = 0;
    high = total - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timestamps[mid] <= xScale.max) {
        idxMax = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const visibleCount = idxMax - idxMin + 1;

    if (viewModeRef.current !== "browse") {
      viewModeRef.current = "browse";
      setViewMode("browse");
    }

    const leftRatio = targetLeft / trackWidth;
    const rightRatio = (targetLeft + currentThumbWidth) / trackWidth;

    let targetStartIdx = Math.round(leftRatio * (total - 1));
    let targetEndIdx = Math.round(rightRatio * (total - 1));

    targetEndIdx = Math.min(total - 1, targetStartIdx + visibleCount - 1);
    targetStartIdx = Math.max(0, targetEndIdx - visibleCount + 1);

    if (targetStartIdx >= 0 && targetEndIdx < total) {
      chart.setScale("x", {
        min: timestamps[targetStartIdx],
        max: timestamps[targetEndIdx],
      });
    }
  }, []);

  const handleScrollbarLeftHandleMouseDown = useCallback((mouseDownEvent: ReactMouseEvent<HTMLDivElement>) => {
    mouseDownEvent.preventDefault();
    mouseDownEvent.stopPropagation();
    const chart = chartRef.current;
    const track = scrollbarTrackRef.current;
    if (!chart || !track) return;

    const { timestamps } = bufferRef.current;
    const total = timestamps.length;
    if (total === 0) return;

    const xScale = chart.scales.x;
    if (xScale.min == null || xScale.max == null) return;

    const isCurrentlyAuto = viewModeRef.current === "auto";
    const currentMaxTime = xScale.max;

    let idxMax = total - 1;
    if (!isCurrentlyAuto) {
      let low = 0, high = total - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (timestamps[mid] <= currentMaxTime) {
          idxMax = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const rect = track.getBoundingClientRect();
      const clickX = moveEvent.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      let targetStartIdx = Math.round(ratio * (total - 1));

      targetStartIdx = Math.min(idxMax - 10, targetStartIdx);
      targetStartIdx = Math.max(0, targetStartIdx);

      if (isCurrentlyAuto) {
        const newAutoPoints = total - targetStartIdx;
        setAutoPoints(Math.max(10, newAutoPoints));
      } else {
        chart.setScale("x", {
          min: timestamps[targetStartIdx],
          max: currentMaxTime,
        });
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  const handleScrollbarRightHandleMouseDown = useCallback((mouseDownEvent: ReactMouseEvent<HTMLDivElement>) => {
    mouseDownEvent.preventDefault();
    mouseDownEvent.stopPropagation();
    const chart = chartRef.current;
    const track = scrollbarTrackRef.current;
    if (!chart || !track) return;

    const { timestamps } = bufferRef.current;
    const total = timestamps.length;
    if (total === 0) return;

    const xScale = chart.scales.x;
    if (xScale.min == null || xScale.max == null) return;

    const currentMinTime = xScale.min;

    let idxMin = 0;
    let low = 0, high = total - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timestamps[mid] >= currentMinTime) {
        idxMin = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const rect = track.getBoundingClientRect();
      const clickX = moveEvent.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, clickX / rect.width));
      let targetEndIdx = Math.round(ratio * (total - 1));

      targetEndIdx = Math.max(idxMin + 10, targetEndIdx);
      targetEndIdx = Math.min(total - 1, targetEndIdx);

      if (ratio >= 0.99) {
        if (viewModeRef.current !== "auto") {
          viewModeRef.current = "auto";
          setViewMode("auto");
        }
        const newAutoPoints = total - idxMin;
        setAutoPoints(Math.max(10, newAutoPoints));
      } else {
        if (viewModeRef.current !== "browse") {
          viewModeRef.current = "browse";
          setViewMode("browse");
        }
        chart.setScale("x", {
          min: currentMinTime,
          max: timestamps[targetEndIdx],
        });
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  const handleScrollbarTrackMouseMove = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const track = scrollbarTrackRef.current;
    const tooltip = scrollbarTooltipRef.current;
    if (!track || !tooltip) return;

    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;

    tooltip.style.display = "flex";

    let tooltipLeft = x;
    const tooltipWidth = tooltip.offsetWidth || 180;

    tooltipLeft = Math.max(tooltipWidth / 2, Math.min(rect.width - tooltipWidth / 2, tooltipLeft));

    tooltip.style.left = `${tooltipLeft}px`;
  }, []);

  const handleScrollbarTrackMouseLeave = useCallback(() => {
    if (scrollbarTooltipRef.current) {
      scrollbarTooltipRef.current.style.display = "none";
    }
  }, []);

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
        paths: uPlot.paths.spline ? uPlot.paths.spline() : undefined,
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
          x: { time: false, auto: false },
          y: { auto: true },
        },
        hooks: {
          draw: [
            (plot) => {
              const { ctx } = plot;
              const { timestamps } = bufferRef.current;
              if (timestamps.length === 0) return;

              const latestTime = timestamps[timestamps.length - 1];
              const xPos = plot.valToPos(latestTime, "x", true);

              if (xPos >= plot.bbox.left && xPos <= plot.bbox.left + plot.bbox.width) {
                ctx.save();
                ctx.beginPath();
                ctx.setLineDash([4, 4]);
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = "#a855f7";
                ctx.moveTo(xPos, plot.bbox.top);
                ctx.lineTo(xPos, plot.bbox.top + plot.bbox.height);
                ctx.stroke();
                ctx.restore();
              }
            }
          ],
          setCursor: [
            (plot) => {
              const { left, top } = plot.cursor;
              if (left == null || top == null || left < 0 || top < 0) {
                // 备注：直接操作 DOM，不触发 re-render
                if (tooltipRef.current) {
                  tooltipRef.current.style.display = "none";
                }
                if (cursorDotRef.current) {
                  cursorDotRef.current.style.display = "none";
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

              // Position the cyan cursor dot on the scrollbar track
              if (cursorDotRef.current && scrollbarTrackRef.current) {
                const trackWidth = scrollbarTrackRef.current.clientWidth;
                const ratio = timestamps.length > 1 ? dataIndex / (timestamps.length - 1) : 0;
                const dotLeft = ratio * trackWidth;
                cursorDotRef.current.style.display = "block";
                cursorDotRef.current.style.left = `${dotLeft}px`;
              }

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
                  <div class="tooltip-ch" style="color: ${chColor}">
                    <span class="tooltip-ch-dot" style="background-color: ${chColor}"></span>
                    CH${closestChIdx + 1}
                  </div>
                  <div class="tooltip-coord">
                    <span class="label">${t("waveform.tooltipTime", { defaultValue: "时间" })}</span>
                    <span class="value">${fmtTime(timestamps[dataIndex])}</span>
                  </div>
                  <div class="tooltip-coord">
                    <span class="label">${t("waveform.tooltipValue", { defaultValue: "数值" })}</span>
                    <span class="value" style="color: ${chColor}">${fmtValue(val)}</span>
                  </div>
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
                if (tooltipX + 160 > containerWidth) {
                  tooltipX = left + plot.bbox.left - 175;
                }
                if (tooltipY + 80 > containerHeight) {
                  tooltipY = top + plot.bbox.top - 95;
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
          setScale: [
            (plot, key) => {
              if (key === "x") {
                updateScrollbarAndInfo(plot);
              }
            }
          ]
        },
      },
      [[], ...Array.from({ length: numChannels }, () => [])],
      el,
    );

    setChannelCount(numChannels);

    if (bufferRef.current.timestamps.length > 0) {
      renderChart(true);
    }
  }, [renderChart, hiddenChannels, t, updateScrollbarAndInfo, theme]);

  // 备注：当手动切换主题时重新创建图表，使网格与坐标轴颜色同步更新
  useEffect(() => {
    if (chartRef.current && channelCount > 0) {
      setTimeout(() => {
        if (chartRef.current && channelCount > 0) {
          initChart(channelCount);
        }
      }, 50);
    }
  }, [theme, channelCount, initChart]);

  // 备注：当系统主题（深色/浅色模式）改变时同步更新图表颜色
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (chartRef.current && channelCount > 0) {
        setTimeout(() => {
          if (chartRef.current && channelCount > 0) {
            initChart(channelCount);
          }
        }, 50);
      }
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [channelCount, initChart]);

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
    const unlistenPromise = listen<DataFrame>("waveform-data", (event) => {
      const frame = event.payload;
      if (!frame) return;

      const numChannels = frame.values.length;
      if (numChannels === 0) return;

      let needInit = false;
      if (bufferRef.current.channels.length === 0) {
        bufferRef.current.channels = Array.from({ length: numChannels }, () => []);
        setChannelCount(numChannels);
        needInit = true;
      } else if (bufferRef.current.channels.length !== numChannels) {
        bufferRef.current = {
          timestamps: [],
          channels: Array.from({ length: numChannels }, () => []),
        };
        setHiddenChannels({}); // P0 #3: 通道数变化时重置隐藏状态
        setChannelCount(numChannels);
        needInit = true;
      }

      const { timestamps, channels } = bufferRef.current;

      // 检测时间断开并插入空数据以断开线条连接
      if (timestamps.length > 0) {
        const lastTime = timestamps[timestamps.length - 1];
        const gapThreshold = Math.max(0.5, 5 * (deltaT / 1000));
        if (frame.timestamp - lastTime > gapThreshold) {
          timestamps.push(lastTime + 0.000001);
          for (let index = 0; index < channels.length; index++) {
            channels[index].push(null);
          }
        }
      }

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

      if (needInit || !chartRef.current) {
        initChart(numChannels);
      }

      const el = containerRef.current;
      const isVisible = el && el.clientWidth > 0;
      if (!pausedRef.current && !panningRef.current && isVisible) {
        const now = performance.now();
        const nextAllowedRender = lastRenderTimeRef.current + deltaT;
        const delay = Math.max(0, nextAllowedRender - now);

        if (renderTimeoutRef.current) {
          clearTimeout(renderTimeoutRef.current);
        }

        renderTimeoutRef.current = setTimeout(() => {
          lastRenderTimeRef.current = performance.now();
          renderChart(false);
        }, delay);
      }
    });

    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, [bufferLimit, deltaT, initChart, renderChart]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const resizeChart = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      if (chartRef.current && width > 0 && height > 0) {
        chartRef.current.setSize({ width, height });
        renderChart(false);
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
  }, [initChart, renderChart]);

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

      if (!pausedRef.current) {
        renderChart(false);
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
      if (renderTimeoutRef.current) {
        clearTimeout(renderTimeoutRef.current);
      }
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
    chartRef.current?.setData(
      [new Float64Array(0), ...Array.from({ length: channelCount }, () => new Float64Array(0))],
      true,
    );
    // Explicitly reset scrollbar visual state and info labels on clear
    const thumb = scrollbarThumbRef.current;
    if (thumb) {
      thumb.style.width = "100%";
      thumb.style.left = "0px";
    }
    if (visiblePointsValRef.current) visiblePointsValRef.current.textContent = "0";
    if (timeDivValRef.current) timeDivValRef.current.textContent = "--/X-div";
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

  const { timestamps, channels } = bufferRef.current;
  const lastIdx = timestamps.length - 1;
  const defaultCursorText = lastIdx >= 0
    ? `Latest ${fmtTime(timestamps[lastIdx])} | ${channels.map((ch, i) => `CH${i + 1} ${fmtValue(ch[lastIdx] ?? null)}`).join("  ")}`
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
        {/* Combined VOFA+ Style Control Panel */}
        <div className="waveform-control-panel">
          {/* Row 1: Parameters Row */}
          <div className="waveform-control-row">
            <label
              className="statusbar-item"
              title={t("waveform.deltaTTooltip", { defaultValue: "设置波形刷新渲染的最小间隔时间（毫秒），数值越小刷新频率越高，默认为 50ms (20Hz)" })}
            >
              {t("waveform.deltaT", { defaultValue: "△t" })}:
              <input
                type="number"
                min={1}
                value={deltaT}
                onChange={(e) => setDeltaT(Math.max(1, Number(e.target.value)))}
                className="statusbar-input"
              />
              ms
              <span className="hz-label">
                ({(1000 / deltaT).toFixed(1)} Hz)
              </span>
            </label>

            <label
              className="statusbar-item"
              title={t("waveform.bufferLimitTooltip", { defaultValue: "设置每个通道在内存中保留的最大采样点数，超出上限的老数据将被淘汰，默认为 50000" })}
            >
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

            <label
              className="statusbar-item"
              title={t("waveform.autoPointsTooltip", { defaultValue: "设定在 Auto 模式下 X 轴可视区域内能容纳显示的数据点个数，默认为 100" })}
            >
              {t("waveform.autoPoints", { defaultValue: "Auto点数对齐" })}:
              <input
                type="number"
                min={10}
                value={autoPoints}
                onChange={(e) => setAutoPoints(Math.max(10, Number(e.target.value)))}
                className="statusbar-input"
              />
            </label>

            <label
              className="statusbar-item"
              title={t("waveform.downsampleTooltip", { defaultValue: "开启高性能 MinMax 下采样数据抽稀，降低大缓冲区下的 GPU 负荷并完美保留信号极值" })}
              style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer", userSelect: "none" }}
            >
              <input
                type="checkbox"
                checked={downsampleEnabled}
                onChange={(e) => setDownsampleEnabled(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              {t("waveform.downsample", { defaultValue: "数据抽稀" })}
            </label>

            <button
              className={`btn-small btn-lock-auto ${viewMode === "auto" ? "btn-active" : ""}`}
              onClick={handleAuto}
            >
              Auto
            </button>
          </div>

          {/* Row 2: Scrollbar Container */}
          <div className="waveform-scrollbar-container">
            <div
              className="waveform-scrollbar-track"
              ref={scrollbarTrackRef}
              onMouseDown={handleScrollbarTrackMouseDown}
              onMouseMove={handleScrollbarTrackMouseMove}
              onMouseLeave={handleScrollbarTrackMouseLeave}
            >
              <div
                className="waveform-scrollbar-thumb"
                ref={scrollbarThumbRef}
                onMouseDown={handleScrollbarThumbMouseDown}
                style={{ left: 0, width: "100%" }}
              >
                {/* Left (Red) drag handle */}
                <div
                  className="scrollbar-handle handle-left"
                  onMouseDown={handleScrollbarLeftHandleMouseDown}
                />
                {/* Right (Purple) drag handle */}
                <div
                  className="scrollbar-handle handle-right"
                  onMouseDown={handleScrollbarRightHandleMouseDown}
                />
              </div>

              {/* Cyan cursor dot */}
              <div
                className="scrollbar-cursor-dot"
                ref={cursorDotRef}
                style={{ display: "none" }}
              />
            </div>

            {/* Scrollbar Tooltip */}
            <div
              ref={scrollbarTooltipRef}
              className="waveform-scrollbar-tooltip"
              style={{ display: "none" }}
            />
          </div>

          {/* Row 3: Info Bar */}
          <div className="waveform-info-bar">
            <button
              className="btn-clear-trash"
              onClick={handleClear}
              onContextMenu={(e) => e.preventDefault()}
              title={t("waveform.clearTooltip", { defaultValue: "左键: 清空采样数据\n右键: 设置不弹出警告" })}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                <line x1="10" y1="11" x2="10" y2="17"></line>
                <line x1="14" y1="11" x2="14" y2="17"></line>
              </svg>
            </button>
            <span className="info-item" title={t("waveform.bufferActiveTooltip", { defaultValue: "当前缓冲区有效数据: 0/ch" })}>
              <span ref={totalPointsValRef} className="info-label-value">0 / {bufferLimit}</span>
            </span>
            <span className="info-divider">|</span>
            <span className="info-item" title={t("waveform.visiblePointsTooltip", { defaultValue: "当前屏幕可视区域数据点数" })}>
              <span ref={visiblePointsValRef} className="info-label-value">0</span>
            </span>
            <span className="info-divider">|</span>
            <span className="info-item" title={t("waveform.timeDivTooltip", { defaultValue: "时间轴网格间距分度值 (X-div)" })}>
              <span ref={timeDivValRef} className="info-label-value">--/X-div</span>
            </span>
          </div>
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
            const { timestamps, channels } = bufferRef.current;
            const lastIdx = timestamps.length - 1;
            const val = lastIdx >= 0 ? (channels[index]?.[lastIdx] ?? null) : null;
            return (
              <div key={index} className={`waveform-sidebar-item ${isHidden ? "hidden" : ""}`}>
                <button
                  className="btn-visibility"
                  onClick={() => toggleChannelVisibility(index)}
                  title={isHidden ? t("waveform.showChannel", { defaultValue: "显示通道" }) : t("waveform.hideChannel", { defaultValue: "屏蔽通道" })}
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
                <span
                  className="channel-value"
                  data-ch-idx={index}
                  style={{ color: isHidden ? "var(--text-muted)" : color }}
                >
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
