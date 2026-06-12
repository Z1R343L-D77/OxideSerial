import { useEffect, useRef, useCallback, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

// 备注：波形面板属性
interface WaveformPanelProps {
  data: { timestamp: number; values: number[] }[];
  maxPoints?: number;
  channelNames?: string[];
}

// 备注：通道颜色（模仿 Serial-Studio 的配色方案）
const CHANNEL_COLORS = [
  "#FF6384", // 红
  "#36A2EB", // 蓝
  "#FFCE56", // 黄
  "#4BC0C0", // 青
  "#9966FF", // 紫
  "#FF9F40", // 橙
  "#C9CBCF", // 灰
  "#7BC8A4", // 绿
];

export function WaveformPanel({ data, maxPoints = 500 }: WaveformPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const [paused, setPaused] = useState(false);
  const [channelCount, setChannelCount] = useState(0);
  const dataRef = useRef<{ timestamps: number[]; channels: number[][] }>({
    timestamps: [],
    channels: [],
  });

  // 备注：初始化图表
  const initChart = useCallback(
    (numChannels: number) => {
      if (!containerRef.current) return;

      // 备注：清理旧图表
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }

      const series: uPlot.Series[] = [
        {
          label: "时间(s)",
          value: (_u, v) => (v != null ? v.toFixed(2) : "-"),
        },
      ];

      for (let i = 0; i < numChannels; i++) {
        series.push({
          label: `CH${i + 1}`,
          stroke: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
          width: 2,
          value: (_u, v) => (v != null ? v.toFixed(3) : "-"),
        });
      }

      const opts: uPlot.Options = {
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight || 300,
        series,
        axes: [
          {
            stroke: "#666",
            grid: { stroke: "#2a2a3e" },
          },
          {
            stroke: "#666",
            grid: { stroke: "#2a2a3e" },
          },
        ],
        cursor: {
          drag: { x: true, y: false },
        },
        scales: {
          x: { time: false },
        },
      };

      const initialData: uPlot.AlignedData = [
        new Float64Array(0),
        ...Array.from({ length: numChannels }, () => new Float64Array(0)),
      ];

      chartRef.current = new uPlot(opts, initialData, containerRef.current);
      setChannelCount(numChannels);

      dataRef.current = { timestamps: [], channels: Array.from({ length: numChannels }, () => []) };
    },
    [],
  );

  // 备注：更新图表数据
  useEffect(() => {
    if (paused) return;
    if (data.length === 0) return;

    const latest = data[data.length - 1];
    const numChannels = latest.values.length;

    // 备注：首次检测到数据时初始化图表
    if (channelCount === 0 && numChannels > 0) {
      initChart(numChannels);
    }

    if (!chartRef.current || channelCount === 0) return;

    // 备注：追加新数据
    const d = dataRef.current;
    d.timestamps.push(latest.timestamp);
    for (let i = 0; i < channelCount; i++) {
      d.channels[i].push(latest.values[i] ?? 0);
    }

    // 备注：限制数据点数量
    while (d.timestamps.length > maxPoints) {
      d.timestamps.shift();
      for (let i = 0; i < channelCount; i++) {
        d.channels[i].shift();
      }
    }

    // 备注：更新图表
    const aligned: uPlot.AlignedData = [
      new Float64Array(d.timestamps),
      ...d.channels.map((ch) => new Float64Array(ch)),
    ];

    chartRef.current.setData(aligned, true);
  }, [data, paused, channelCount, maxPoints, initChart]);

  // 备注：窗口大小变化时重绘
  useEffect(() => {
    const handleResize = () => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.setSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight || 300,
        });
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // 备注：组件卸载时销毁图表
  useEffect(() => {
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, []);

  const handleClear = () => {
    dataRef.current = { timestamps: [], channels: Array.from({ length: channelCount }, () => []) };
    if (chartRef.current) {
      chartRef.current.setData(
        [
          new Float64Array(0),
          ...Array.from({ length: channelCount }, () => new Float64Array(0)),
        ],
        true,
      );
    }
  };

  return (
    <div className="waveform-panel">
      <div className="waveform-toolbar">
        <span className="waveform-title">波形显示</span>
        <span className="waveform-channels">
          {channelCount > 0 ? `${channelCount} 通道` : "等待数据..."}
        </span>
        <button
          className={`btn-small ${paused ? "btn-resume" : "btn-pause"}`}
          onClick={() => setPaused(!paused)}
        >
          {paused ? "▶ 恢复" : "⏸ 暂停"}
        </button>
        <button className="btn-small btn-clear" onClick={handleClear}>
          清空
        </button>
      </div>
      <div className="waveform-container" ref={containerRef} />
    </div>
  );
}
