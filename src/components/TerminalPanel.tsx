import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react";
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

const renderMarkdownText = (text: string) => {
  const parts = text.split("**");
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return <strong key={index}>{part}</strong>;
    }
    return part;
  });
};

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

  // ================= 快捷发送相关状态 & 逻辑 =================
  const [showQuickSend, setShowQuickSend] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("terminal-show-quick-send");
      return saved === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    localStorage.setItem("terminal-show-quick-send", String(showQuickSend));
  }, [showQuickSend]);

  const [quickSendWidth, setQuickSendWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("terminal-quick-send-width");
      return saved ? Number(saved) : 360;
    } catch {
      return 360;
    }
  });

  useEffect(() => {
    localStorage.setItem("terminal-quick-send-width", String(quickSendWidth));
  }, [quickSendWidth]);

  interface QuickSendItem {
    id: string;
    order: number;
    delay: number;
    hex: boolean;
    data: string;
    comment: string;
  }

  const DEFAULT_QUICK_SEND_ITEMS: QuickSendItem[] = useMemo(() => 
    Array.from({ length: 10 }, (_, i) => ({
      id: `qs-${i + 1}`,
      order: 0,
      delay: 1000,
      hex: false,
      data: "",
      comment: "",
    })), []);

  const [quickSendItems, setQuickSendItems] = useState<QuickSendItem[]>(() => {
    try {
      const saved = localStorage.getItem("terminal-quick-send-items");
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error(e);
    }
    return DEFAULT_QUICK_SEND_ITEMS;
  });

  useEffect(() => {
    localStorage.setItem("terminal-quick-send-items", JSON.stringify(quickSendItems));
  }, [quickSendItems]);

  const quickSendItemsRef = useRef(quickSendItems);
  useEffect(() => {
    quickSendItemsRef.current = quickSendItems;
  }, [quickSendItems]);

  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentValue, setEditingCommentValue] = useState("");
  const [isCycling, setIsCycling] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);

  const cycleTimerRef = useRef<number | null>(null);
  const cycleIndexRef = useRef(0);

  const handleQuickSendResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = quickSendWidth;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = startX - moveEvent.clientX;
      setQuickSendWidth(Math.max(250, Math.min(800, startWidth + deltaX)));
    };
    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [quickSendWidth]);

  const handleUpdateItem = useCallback((id: string, field: keyof QuickSendItem, value: any) => {
    setQuickSendItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  }, []);

  const handleAddItem = useCallback(() => {
    setQuickSendItems((prev) => [
      ...prev,
      {
        id: `qs-${Date.now()}`,
        order: 0,
        delay: 1000,
        hex: false,
        data: "",
        comment: "",
      },
    ]);
  }, []);

  const handleDeleteItem = useCallback((id: string) => {
    setQuickSendItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleRemoveAll = useCallback(() => {
    setQuickSendItems(DEFAULT_QUICK_SEND_ITEMS);
  }, [DEFAULT_QUICK_SEND_ITEMS]);

  const handleDoubleClickComment = useCallback((item: QuickSendItem) => {
    setEditingCommentId(item.id);
    setEditingCommentValue(item.comment);
  }, []);

  const handleSaveComment = useCallback((id: string) => {
    setQuickSendItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, comment: editingCommentValue } : item))
    );
    setEditingCommentId(null);
  }, [editingCommentValue]);

  // 发送单条字符串/Hex
  const sendString = useCallback(async (data: string, hex: boolean) => {
    if (!status.connected || !data.trim()) return;
    try {
      let bytes: number[];
      if (hex) {
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
        const enc = encoding;
        if (enc === "gbk") {
          bytes = await invoke<number[]>("encode_string", { text: data, encoding: "gbk" });
        } else {
          bytes = Array.from(new TextEncoder().encode(data));
        }
      }
      const lineEndingBytes: Record<string, number[]> = { none: [], LF: [0x0A], CR: [0x0D], CRLF: [0x0D, 0x0A], LFCR: [0x0A, 0x0D] };
      const extra = lineEndingBytes[lineEnding] ?? [];
      if (extra.length > 0) bytes = [...bytes, ...extra];

      await invoke("send_data", { data: bytes });
    } catch (e) {
      onAddTextLog("ERROR", `${e}`);
    }
  }, [status.connected, encoding, lineEnding, onAddTextLog]);

  // 循环发送逻辑
  useEffect(() => {
    if (!status.connected && isCycling) {
      setIsCycling(false);
    }
  }, [status.connected, isCycling]);

  useEffect(() => {
    if (!isCycling || !status.connected) {
      if (cycleTimerRef.current) {
        clearTimeout(cycleTimerRef.current);
        cycleTimerRef.current = null;
      }
      return;
    }

    cycleIndexRef.current = 0;

    const runCycle = async () => {
      if (!isCycling || !status.connected) return;

      const activeItems = quickSendItemsRef.current
        .filter((item) => item.order > 0 && item.data.trim().length > 0)
        .sort((a, b) => a.order - b.order);

      if (activeItems.length === 0) {
        setIsCycling(false);
        return;
      }

      if (cycleIndexRef.current >= activeItems.length) {
        cycleIndexRef.current = 0;
      }

      const currentItem = activeItems[cycleIndexRef.current];
      if (currentItem) {
        await sendString(currentItem.data, currentItem.hex);
      }
      
      cycleIndexRef.current = (cycleIndexRef.current + 1) % activeItems.length;
      const nextDelay = currentItem ? currentItem.delay : 1000;
      
      cycleTimerRef.current = window.setTimeout(() => {
        void runCycle();
      }, Math.max(10, nextDelay));
    };

    void runCycle();

    return () => {
      if (cycleTimerRef.current) {
        clearTimeout(cycleTimerRef.current);
        cycleTimerRef.current = null;
      }
    };
  }, [isCycling, status.connected, sendString]);

  // 导出INI文件
  const generateIni = (items: QuickSendItem[]): string => {
    let content = "; OxideSerial QuickSend Configuration\n\n";
    items.forEach((item, index) => {
      content += `[Item${index + 1}]\n`;
      content += `order=${item.order}\n`;
      content += `delay=${item.delay}\n`;
      content += `hex=${item.hex ? 1 : 0}\n`;
      content += `data=${item.data}\n`;
      content += `comment=${item.comment}\n\n`;
    });
    return content;
  };

  const handleExport = useCallback(async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const filePath = await save({
        defaultPath: "quick-send-config.ini",
        filters: [{ name: "Configuration", extensions: ["ini"] }],
      });
      if (!filePath) return;
      const content = generateIni(quickSendItems);
      await writeTextFile(filePath, content);
      onAddTextLog("INFO", `快捷发送配置导出成功: ${filePath}`);
    } catch (e) {
      onAddTextLog("ERROR", `导出配置失败: ${e}`);
    }
  }, [quickSendItems, onAddTextLog]);

  // 导入INI文件
  const parseIni = (text: string): QuickSendItem[] => {
    const items: QuickSendItem[] = [];
    const lines = text.split(/\r?\n/);
    let currentItem: Partial<QuickSendItem> | null = null;
    let sectionIndex = 1;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) {
        continue;
      }
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        if (currentItem && (currentItem.data !== undefined || currentItem.comment !== undefined)) {
          items.push({
            id: currentItem.id || `qs-${Date.now()}-${sectionIndex++}`,
            order: currentItem.order ?? 0,
            delay: currentItem.delay ?? 1000,
            hex: !!currentItem.hex,
            data: currentItem.data || "",
            comment: currentItem.comment || "",
          });
        }
        currentItem = {
          id: `qs-${Date.now()}-${sectionIndex}`,
        };
      } else if (currentItem) {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.substring(0, eqIdx).trim().toLowerCase();
          const value = trimmed.substring(eqIdx + 1).trim();
          if (key === "order") {
            currentItem.order = parseInt(value, 10) || 0;
          } else if (key === "delay") {
            currentItem.delay = parseInt(value, 10) || 1000;
          } else if (key === "hex") {
            currentItem.hex = value === "1" || value.toLowerCase() === "true";
          } else if (key === "data") {
            currentItem.data = value;
          } else if (key === "comment") {
            currentItem.comment = value;
          }
        }
      }
    }

    if (currentItem && (currentItem.data !== undefined || currentItem.comment !== undefined)) {
      items.push({
        id: currentItem.id || `qs-${Date.now()}-${sectionIndex++}`,
        order: currentItem.order ?? 0,
        delay: currentItem.delay ?? 1000,
        hex: !!currentItem.hex,
        data: currentItem.data || "",
        comment: currentItem.comment || "",
      });
    }

    return items.length > 0 ? items : DEFAULT_QUICK_SEND_ITEMS;
  };

  const handleImport = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const filePath = await open({
        filters: [{ name: "Configuration", extensions: ["ini"] }],
        multiple: false,
      });
      if (!filePath || Array.isArray(filePath)) return;
      const content = await readTextFile(filePath);
      const parsed = parseIni(content);
      setQuickSendItems(parsed);
      onAddTextLog("INFO", `快捷发送配置导入成功: ${filePath}`);
    } catch (e) {
      onAddTextLog("ERROR", `导入配置失败: ${e}`);
    }
  }, [onAddTextLog, DEFAULT_QUICK_SEND_ITEMS]);

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
  const handleSendRef = useRef<() => Promise<void>>(async () => { });
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
          
          <span className="toolbar-divider" />
          <label style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "4px", color: "var(--text-secondary)", cursor: "pointer", userSelect: "none" }}>
            <input type="checkbox" checked={showQuickSend} onChange={(e) => setShowQuickSend(e.target.checked)} /> 
            {t("terminal.quickSend", { defaultValue: "快捷发送" })}
          </label>
        </div>
      </div>

      {/* 备注：终端主要显示区域，支持左侧日志和右侧快捷发送侧边栏 */}
      <div className="terminal-display-wrapper" style={{ display: 'flex', flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <div 
          className="log-container" 
          ref={logContainerRef} 
          role="log" 
          aria-live="polite"
          style={{ flex: 1, fontSize: `${fontSize}px`, minWidth: 0 }}
        >
          <List<any>
            listRef={listRef}
            rowCount={filteredLogs.length}
            rowHeight={LOG_ROW_HEIGHT}
            rowComponent={LogRow as any}
            rowProps={{
              filteredLogs,
              showHex,
              showTimestamp,
              encoding,
            }}
            overscanCount={20}
          />
        </div>
        {showQuickSend && (
          <div className="quick-send-panel" style={{ width: `${quickSendWidth}px` }}>
            <div className="quick-send-resizer" onMouseDown={handleQuickSendResizerMouseDown} />
            <div className="quick-send-header">
              <span className="title">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', verticalAlign: 'middle', color: 'var(--accent)' }}>
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
                <span style={{ verticalAlign: 'middle' }}>{t('quickSendTitle', { defaultValue: '多条字符串发送' })}</span>
              </span>
              <div className="quick-send-header-buttons">
                <button className="btn-icon-small" onClick={handleAddItem} title={t('quickSendAddRow', { defaultValue: '添加一行' })}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
                <button className="btn-icon-small" onClick={handleRemoveAll} title={t('quickSendDeleteRow', { defaultValue: '重置' })}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 4v6h-6"></path>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                  </svg>
                </button>
                <button className="btn-icon-small" onClick={() => setShowHelpModal(true)} title={t('quickSendHelp', { defaultValue: '帮助' })}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                </button>
              </div>
            </div>
            <div className="quick-send-body">
              <table className="quick-send-table">
                <thead>
                  <tr>
                    <th style={{ width: '42px', textAlign: 'center' }}>{t('quickSendOrder', { defaultValue: '顺序' })}</th>
                    <th style={{ width: '58px', textAlign: 'center' }}>{t('quickSendDelay', { defaultValue: '延时' })}</th>
                    <th style={{ width: '38px', textAlign: 'center' }}>{t('quickSendHex', { defaultValue: 'HEX' })}</th>
                    <th>{t('quickSendString', { defaultValue: '字符串/数据' })}</th>
                    <th style={{ width: '85px' }}>{t('quickSendCommentPlaceholder', { defaultValue: '注释' })}</th>
                    <th style={{ width: '68px', textAlign: 'center' }}>{t('quickSendClickSend', { defaultValue: '操作' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {quickSendItems.map((item) => (
                    <tr key={item.id}>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="number"
                          value={item.order}
                          min={0}
                          className="input-order"
                          onChange={(e) => handleUpdateItem(item.id, 'order', parseInt(e.target.value, 10) || 0)}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="number"
                          value={item.delay}
                          min={10}
                          step={100}
                          className="input-delay"
                          onChange={(e) => handleUpdateItem(item.id, 'delay', parseInt(e.target.value, 10) || 1000)}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <label className="checkbox-custom-container">
                          <input
                            type="checkbox"
                            checked={item.hex}
                            onChange={(e) => handleUpdateItem(item.id, 'hex', e.target.checked)}
                          />
                          <span className="checkbox-custom-checkmark" />
                        </label>
                      </td>
                      <td>
                        <input
                          type="text"
                          value={item.data}
                          className="input-data"
                          placeholder={t('quickSendDataPlaceholder', { defaultValue: '发送数据...' })}
                          onChange={(e) => handleUpdateItem(item.id, 'data', e.target.value)}
                        />
                      </td>
                      <td>
                        {editingCommentId === item.id ? (
                          <input
                            type="text"
                            value={editingCommentValue}
                            className="input-comment"
                            onChange={(e) => setEditingCommentValue(e.target.value)}
                            onBlur={() => handleSaveComment(item.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveComment(item.id);
                            }}
                            autoFocus
                          />
                        ) : (
                          <div
                            className={`quick-send-comment-cell ${!item.comment ? 'empty' : ''}`}
                            onDoubleClick={() => handleDoubleClickComment(item)}
                            title={t('quickSendDoubleClickCommentTooltip', { defaultValue: '双击修改注释' })}
                          >
                            <span>{item.comment || t('quickSendCommentPlaceholder', { defaultValue: '双击编辑' })}</span>
                            <svg className="edit-indicator-icon" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                              <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                            </svg>
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <button
                          className="btn-send-row"
                          onClick={() => void sendString(item.data, item.hex)}
                          disabled={!status.connected}
                          title={t('quickSendClickSend', { defaultValue: '发送' })}
                        >
                          {t('quickSendClickSend', { defaultValue: '发送' })}
                        </button>
                        <button
                          className="btn-delete-row"
                          onClick={() => handleDeleteItem(item.id)}
                          title={t('quickSendDeleteRow', { defaultValue: '删除' })}
                        >
                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="quick-send-footer">
              <div className="quick-send-footer-cycle">
                <label className="switch-control" title={t('quickSendCycle', { defaultValue: '循环发送' })}>
                  <input
                    type="checkbox"
                    checked={isCycling}
                    onChange={(e) => setIsCycling(e.target.checked)}
                    disabled={!status.connected}
                  />
                  <span className="switch-slider" />
                </label>
                <span className="switch-label">{t('quickSendCycle', { defaultValue: '循环发送' })}</span>
              </div>
              <div className="quick-send-footer-buttons">
                <button className="btn-footer-action" onClick={handleImport}>
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px' }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  {t('quickSendImport', { defaultValue: '导入ini' })}
                </button>
                <button className="btn-footer-action" onClick={handleExport}>
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '4px' }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  {t('quickSendExport', { defaultValue: '导出ini' })}
                </button>
              </div>
            </div>
          </div>
        )}
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

      {showHelpModal && (
        <div className="quick-send-modal-backdrop" onClick={() => setShowHelpModal(false)}>
          <div className="quick-send-modal" onClick={(e) => e.stopPropagation()}>
            <div className="quick-send-modal-header">
              <h4>{t('quickSendHelpModalTitle', { defaultValue: '多条发送/循环发送使用帮助' })}</h4>
              <button className="quick-send-modal-close" onClick={() => setShowHelpModal(false)}>✕</button>
            </div>
            <div className="quick-send-modal-content">
              <p>{renderMarkdownText(t('quickSendHelpDesc1', { defaultValue: '1. **快捷发送**：点击【发送】按钮可以直接向串口发送该行的数据。' }))}</p>
              <p>{renderMarkdownText(t('quickSendHelpDesc2', { defaultValue: '2. **双击注释**：在注释单元格上双击，可以直接修改其备注名称。' }))}</p>
              <p>{renderMarkdownText(t('quickSendHelpDesc3', { defaultValue: '3. **循环发送**：勾选下方【循环发送】后，系统将筛选出所有【顺序】大于 0 的行，并按数值从小到大循环发送，每行发送完毕后延时对应毫秒数。' }))}</p>
              <p>{renderMarkdownText(t('quickSendHelpDesc4', { defaultValue: '4. **导入/导出**：支持以标准 .ini 格式配置文件批量导入与导出快捷指令列表。' }))}</p>
            </div>
            <div className="quick-send-modal-footer">
              <button onClick={() => setShowHelpModal(false)}>{t('common.confirm', { defaultValue: '我知道了' })}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}



// 备注：虚拟列表行渲染器，移到组件外部并使用 React.memo，避免在 logs 追加时因类型重建导致完全销毁重建 DOM (极其卡顿)
const LogRow = memo(({ index, style, filteredLogs, showHex, showTimestamp, encoding }: {
  index: number;
  style: React.CSSProperties;
  filteredLogs: LogEntry[];
  showHex: boolean;
  showTimestamp: boolean;
  encoding: "utf-8" | "gbk";
}) => {
  const log = filteredLogs[index];
  if (!log) return null;

  // 优化：优先使用预先解码好的 gbk 文本，避免在渲染时高频调用昂贵的 TextDecoder 及字符串拆分操作
  const display = log.data || (showHex ? log.hex : (encoding === "gbk" ? (log.gbk ?? log.ascii) : log.ascii));
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
}, (prev, next) => {
  // 核心优化：高精度的 React.memo 比较，仅在索引、定位样式或核心过滤状态变化，且当前行日志发生改变时才触发重绘
  return (
    prev.index === next.index &&
    prev.style.top === next.style.top &&
    prev.style.height === next.style.height &&
    prev.showHex === next.showHex &&
    prev.showTimestamp === next.showTimestamp &&
    prev.encoding === next.encoding &&
    prev.filteredLogs[prev.index] === next.filteredLogs[next.index]
  );
});
