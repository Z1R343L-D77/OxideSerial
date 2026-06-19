import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { List } from "react-window";
import type { ListImperativeAPI } from "react-window";
import type { LogEntry, SerialStatus } from "../types/serial";

const SEND_HISTORY_LIMIT = 20;
const LOG_ROW_HEIGHT = 22;

interface TerminalPanelProps {
  logs: LogEntry[];
  logContainerRef: React.RefObject<HTMLDivElement | null>;
  status: SerialStatus;
  byteStats: [number, number];
  onAddTextLog: (direction: string, text: string) => void;
  onClearLogs: () => void;
  onExportLogs: (showTimestamp: boolean, showHex: boolean, encoding: "utf-8" | "gbk") => void;
}

export function TerminalPanel({ logs, logContainerRef, status, byteStats, onAddTextLog, onClearLogs, onExportLogs }: TerminalPanelProps) {
  const { t } = useTranslation();

  const [sendMode, setSendMode] = useState<"ascii" | "hex">("ascii");
  const [showHex, setShowHex] = useState(false);
  const [showTimestamp, setShowTimestamp] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("terminal-show-timestamp");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [showRx, setShowRx] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("terminal-show-rx");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [showTx, setShowTx] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("terminal-show-tx");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [fontSize, setFontSize] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("terminal-font-size");
      return saved ? Number(saved) : 11;
    } catch {
      return 11;
    }
  });
  const [sendData, setSendData] = useState("");
  const [autoSend, setAutoSend] = useState(false);
  const [autoSendInterval, setAutoSendInterval] = useState(1000);
  const [lineEnding, setLineEnding] = useState<"none" | "LF" | "CR" | "CRLF" | "LFCR">("none");
  const [sendHistory, setSendHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [encoding, setEncoding] = useState<"utf-8" | "gbk">(() => {
    try {
      const saved = localStorage.getItem("terminal-encoding");
      return (saved as "utf-8" | "gbk") || "utf-8";
    } catch {
      return "utf-8";
    }
  });

  useEffect(() => {
    localStorage.setItem("terminal-encoding", encoding);
  }, [encoding]);

  useEffect(() => {
    localStorage.setItem("terminal-show-timestamp", String(showTimestamp));
  }, [showTimestamp]);

  useEffect(() => {
    localStorage.setItem("terminal-show-rx", String(showRx));
  }, [showRx]);

  useEffect(() => {
    localStorage.setItem("terminal-show-tx", String(showTx));
  }, [showTx]);

  useEffect(() => {
    localStorage.setItem("terminal-font-size", String(fontSize));
  }, [fontSize]);

  // 备注：虚拟列表 ref，用于自动滚动
  const listRef = useRef<ListImperativeAPI>(null);

  // 备注：过滤后的日志
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (log.direction === "RX" && !showRx) return false;
      if (log.direction === "TX" && !showTx) return false;
      return true;
    });
  }, [logs, showRx, showTx]);

  // 备注：虚拟列表数据变更后自动滚动到底部
  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (filteredLogs.length > prevLengthRef.current && listRef.current) {
      listRef.current.scrollToRow({ index: filteredLogs.length - 1, align: "end" });
    }
    prevLengthRef.current = filteredLogs.length;
  }, [filteredLogs.length]);

  // 备注：通过 ref 读取最新值，保证 auto-send interval 稳定
  const sendDataRef = useRef("");
  const lineEndingRef = useRef(lineEnding);
  const statusRef = useRef(status);
  const sendModeRef = useRef(sendMode);
  const encodingRef = useRef(encoding);
  useEffect(() => { sendDataRef.current = sendData; }, [sendData]);
  useEffect(() => { lineEndingRef.current = lineEnding; }, [lineEnding]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { sendModeRef.current = sendMode; }, [sendMode]);
  useEffect(() => { encodingRef.current = encoding; }, [encoding]);

  // 备注：切换 ASCII/HEX 时自动转换输入框格式
  const handleSendModeChange = useCallback((mode: "ascii" | "hex") => {
    setSendData((prev) => {
      if (mode === "hex") {
        const raw = prev.replace(/\s/g, "");
        return raw.replace(/(.{2})/g, "$1 ").trim();
      }
      return prev.replace(/\s/g, "");
    });
    setSendMode(mode);
  }, []);

  // 备注：发送数据
  const handleSendRef = useRef<() => Promise<void>>(async () => {});
  handleSendRef.current = async () => {
    const s = statusRef.current;
    const data = sendDataRef.current;
    const mode = sendModeRef.current;
    const ending = lineEndingRef.current;
    if (!s.connected || !data.trim()) return;
    try {
      let bytes: number[];
      if (mode === "hex") {
        const hexStr = data.replace(/\s+/g, "");
        if (hexStr.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hexStr)) {
          onAddTextLog("ERROR", "HEX 格式错误：包含非法字符或长度为奇数");
          return;
        }
        bytes = [];
        for (let i = 0; i < hexStr.length; i += 2) {
          bytes.push(parseInt(hexStr.substring(i, i + 2), 16));
        }
      } else {
        const enc = encodingRef.current;
        if (enc === "gbk") {
          bytes = await invoke<number[]>("encode_string", { text: data, encoding: "gbk" });
        } else {
          bytes = Array.from(new TextEncoder().encode(data));
        }
      }
      const lineEndingBytes: Record<string, number[]> = { none: [], LF: [0x0A], CR: [0x0D], CRLF: [0x0D, 0x0A], LFCR: [0x0A, 0x0D] };
      const extra = lineEndingBytes[ending] ?? [];
      if (extra.length > 0) bytes = [...bytes, ...extra];

      await invoke("send_data", { data: bytes });
      setSendHistory((prev) => {
        const filtered = prev.filter((item) => item !== data);
        return [data, ...filtered].slice(0, SEND_HISTORY_LIMIT);
      });
    } catch (e) {
      onAddTextLog("ERROR", `${e}`);
    }
  };
  const handleSend = useCallback(() => { void handleSendRef.current(); }, []);

  // 备注：自动发送
  const autoSendTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (autoSend && status.connected) {
      autoSendTimerRef.current = window.setInterval(() => { void handleSendRef.current(); }, autoSendInterval);
    } else {
      if (autoSendTimerRef.current) { clearInterval(autoSendTimerRef.current); autoSendTimerRef.current = null; }
    }
    return () => { if (autoSendTimerRef.current) clearInterval(autoSendTimerRef.current); };
  }, [autoSend, status.connected, autoSendInterval]);

  // 备注：虚拟列表行渲染器
  const LogRow = useCallback(({ index, style }: { index: number; style: React.CSSProperties }) => {
    const log = filteredLogs[index];
    if (!log) return null;
    const display = log.data || (showHex ? log.hex : decodeLogEntry(log.hex, log.ascii, encoding));
    const byteLen = log.hex ? log.hex.split(" ").filter(Boolean).length : 0;
    return (
      <div style={style} className={`log-entry log-${log.direction.toLowerCase()}`}>
        <span className="log-dir">{log.direction}</span>
        <span className="log-data">
          {showTimestamp && <span className="log-time" style={{ color: "var(--text-muted)", marginRight: "6px" }}>[{log.timestamp}]</span>}
          {display}
          {log.hex && <span className="log-len" style={{ color: "var(--text-muted)", marginLeft: "6px" }}>[{byteLen}B]</span>}
        </span>
      </div>
    );
  }, [filteredLogs, showHex, showTimestamp, encoding]);

  return (
    <section className="panel terminal-panel" style={{ display: "flex" }}>
      <div className="terminal-header">
        <h3>{t("terminal.title", { defaultValue: "终端" })}</h3>
        <div className="terminal-controls" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {status.connected && (
            <span className="byte-stats" style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "Consolas, monospace", marginRight: "4px" }}>
              RX: {(byteStats[0] / 1024).toFixed(1)}K TX: {(byteStats[1] / 1024).toFixed(1)}K
            </span>
          )}
          
          {/* 显示方式: 字符串 (Abc) / 十六进制 (Hex) */}
          <button
            className={`btn-toolbar-toggle ${!showHex ? "active" : ""}`}
            onClick={() => setShowHex(false)}
            title={t("terminal.displayModeString", { defaultValue: "显示方式: 字符串" })}
            style={{ fontStyle: "italic", fontWeight: "bold" }}
          >
            Abc
          </button>
          <button
            className={`btn-toolbar-toggle ${showHex ? "active" : ""}`}
            onClick={() => setShowHex(true)}
            title={t("terminal.displayModeHex", { defaultValue: "显示方式: 十六进制" })}
          >
            Hex
          </button>

          <span className="toolbar-divider" />

          {/* Rx 过滤 */}
          <button
            className={`btn-toolbar-toggle ${showRx ? "active-rx" : ""}`}
            onClick={() => setShowRx(prev => !prev)}
            title={t("terminal.showRxTitle", { defaultValue: "当前: 显示接收数据" })}
          >
            Rx
          </button>
          {/* Tx 过滤 */}
          <button
            className={`btn-toolbar-toggle ${showTx ? "active-tx" : ""}`}
            onClick={() => setShowTx(prev => !prev)}
            title={t("terminal.showTxTitle", { defaultValue: "当前: 显示已发送数据" })}
          >
            Tx
          </button>

          <span className="toolbar-divider" />

          {/* 字体大小控制 */}
          <span className="toolbar-label-t" title={t("terminal.fontSize", { defaultValue: "字体大小" })}>T</span>
          <button
            className="btn-toolbar-action"
            onClick={() => setFontSize(prev => Math.min(20, prev + 1))}
            title={t("terminal.fontSizeIncrease", { defaultValue: "增大字号" })}
            style={{ padding: "0 6px", minWidth: "18px" }}
          >
            +
          </button>
          <button
            className="btn-toolbar-action"
            onClick={() => setFontSize(prev => Math.max(10, prev - 1))}
            title={t("terminal.fontSizeDecrease", { defaultValue: "减小字号" })}
            style={{ padding: "0 6px", minWidth: "18px" }}
          >
            -
          </button>

          <span className="toolbar-divider" />

          {/* 编码选择 */}
          <select 
            value={encoding} 
            onChange={(e) => setEncoding(e.target.value as "utf-8" | "gbk")} 
            className="toolbar-select" 
            title={t("terminal.encodingTitle", { defaultValue: "编码格式" })}
          >
            <option value="utf-8">UTF-8</option>
            <option value="gbk">GBK</option>
          </select>

          <span className="toolbar-divider" />

          <label style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "4px", color: "var(--text-secondary)", cursor: "pointer", userSelect: "none" }}>
            <input type="checkbox" checked={showTimestamp} onChange={(e) => setShowTimestamp(e.target.checked)} /> 
            {t("terminal.showTimestamp", { defaultValue: "时间戳" })}
          </label>
          <button className="btn-small" onClick={onClearLogs}>{t("terminal.clear", { defaultValue: "清空" })}</button>
          <button className="btn-small" onClick={() => onExportLogs(showTimestamp, showHex, encoding)}>{t("terminal.export", { defaultValue: "导出" })}</button>
        </div>
      </div>
      {/* 备注：使用 react-window 虚拟列表替代原始 DOM 列表，仅渲染可见行 */}
      <div 
        className="log-container" 
        ref={logContainerRef} 
        role="log" 
        aria-live="polite"
        style={{ fontSize: `${fontSize}px` }}
      >
        <List<any>
          listRef={listRef}
          rowCount={filteredLogs.length}
          rowHeight={LOG_ROW_HEIGHT}
          rowComponent={LogRow}
          rowProps={{}}
          overscanCount={20}
        />
      </div>
      <div className="send-area">
        <div className="send-controls">
          <label><input type="radio" checked={sendMode === "ascii"} onChange={() => handleSendModeChange("ascii")} /> ABC</label>
          <label><input type="radio" checked={sendMode === "hex"} onChange={() => handleSendModeChange("hex")} /> HEX</label>
          <label className="auto-send"><input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} /> {t("terminal.autoSend", { defaultValue: "自动" })}</label>
          <input type="number" min={100} value={autoSendInterval} onChange={(e) => setAutoSendInterval(Number(e.target.value))} className="interval" />
          <span>ms</span>
        </div>
        <div className="send-row">
          <textarea
            value={sendData}
            onChange={(e) => {
              if (sendMode === "hex") {
                const raw = e.target.value.replace(/[^0-9a-fA-F]/g, "");
                setSendData(raw.replace(/(.{2})/g, "$1 ").trim());
              } else {
                setSendData(e.target.value);
              }
            }}
            placeholder={sendMode === "hex" ? t("terminal.hexPlaceholder", { defaultValue: "01 03 00 00 00 01" }) : t("terminal.placeholder", { defaultValue: "输入文本" })}
            onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); handleSend(); } }}
          />
          <div className="send-buttons">
            <button className="btn-icon clear-btn" onClick={() => setSendData("")} title={t("terminal.clearInput", { defaultValue: "清空输入" })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
            <div className="history-wrapper">
              <button className="btn-icon history-btn" onClick={() => setShowHistory(!showHistory)} title={t("terminal.history", { defaultValue: "发送记录" })}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
                  <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
                </svg>
              </button>
              {showHistory && sendHistory.length > 0 && (
                <div className="history-dropdown">
                  {sendHistory.map((item, index) => (
                    <div key={index} className="history-item" onClick={() => { setSendData(item); setShowHistory(false); }}>
                      {item.length > 40 ? item.slice(0, 40) + "..." : item}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <select value={lineEnding} onChange={(e) => setLineEnding(e.target.value as typeof lineEnding)} className="line-ending-select" title={t("terminal.lineEnding", { defaultValue: "行尾追加" })}>
              <option value="none">{t("terminal.lineEndingNone", { defaultValue: "无" })}</option>
              <option value="LF">{t("terminal.lineEndingLf", { defaultValue: "LF (\\n)" })}</option>
              <option value="CR">{t("terminal.lineEndingCr", { defaultValue: "CR (\\r)" })}</option>
              <option value="CRLF">{t("terminal.lineEndingCrLf", { defaultValue: "CRLF (\\r\\n)" })}</option>
              <option value="LFCR">{t("terminal.lineEndingLfCr", { defaultValue: "LFCR (\\n\\r)" })}</option>
            </select>
            <button className="btn-send" onClick={handleSend} disabled={!status.connected}>
              {t("terminal.send", { defaultValue: "发送" })}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function decodeLogEntry(hexStr: string, asciiStr: string, encoding: "utf-8" | "gbk"): string {
  if (!hexStr) return asciiStr;
  const hexBytes = hexStr.split(" ").filter(Boolean);
  if (hexBytes.length === 0) return "";
  try {
    const bytes = new Uint8Array(hexBytes.map(h => parseInt(h, 16)));
    const decoder = new TextDecoder(encoding);
    return decoder.decode(bytes);
  } catch (e) {
    return asciiStr;
  }
}
