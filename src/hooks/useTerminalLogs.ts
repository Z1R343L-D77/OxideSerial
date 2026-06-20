import { useState, useRef, useCallback, useEffect } from "react";
import type { LogEntry } from "../types/serial";

export function useTerminalLogs(locale: string, maxLogs: number = 2000) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // 备注：RAF 节流缓冲队列 — 防止高速数据流造成 React 过度更新
  const pendingLogs = useRef<LogEntry[]>([]);
  const rafId = useRef<number | null>(null);

  const flushPendingLogs = useCallback(() => {
    rafId.current = null;
    if (pendingLogs.current.length === 0) return;
    const batch = pendingLogs.current;
    pendingLogs.current = [];
    setLogs((prev) => [...prev, ...batch].slice(-maxLogs));
  }, [maxLogs]);

  const scheduleFlush = useCallback(() => {
    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(flushPendingLogs);
    }
  }, [flushPendingLogs]);

  // 备注：清理 RAF
  useEffect(() => {
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, []);

  // 备注：添加串口数据日志（同时存储 hex 和 ascii，渲染时根据 showHex 切换）
  const addLog = useCallback((direction: string, hex: string, ascii: string, timestamp?: string) => {
    const id = ++logIdRef.current;
    const time = timestamp || new Date().toLocaleTimeString(locale, { hour12: false });
    const gbk = hex ? decodeLogEntry(hex, ascii, "gbk") : ascii;
    pendingLogs.current.push({ id, timestamp: time, direction, data: "", hex, ascii, gbk });
    scheduleFlush();
  }, [locale, scheduleFlush]);

  // 备注：添加普通日志（非串口数据，如 INFO/ERROR）
  const addTextLog = useCallback((direction: string, text: string) => {
    const id = ++logIdRef.current;
    const timestamp = new Date().toLocaleTimeString(locale, { hour12: false });
    pendingLogs.current.push({ id, timestamp, direction, data: text, hex: "", ascii: text, gbk: text });
    scheduleFlush();
  }, [locale, scheduleFlush]);

  const clearLogs = useCallback(() => {
    pendingLogs.current = [];
    setLogs([]);
  }, []);

  // U7: 导出终端日志
  const exportLogs = useCallback(async (showTimestamp = true, showHex = false, encoding: "utf-8" | "gbk" = "utf-8") => {
    if (logs.length === 0) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = await save({
        defaultPath: `log-${stamp}.txt`,
        filters: [{ name: "Text", extensions: ["txt", "log"] }],
      });
      if (!filePath) return;

      const content = logs.map((l) => {
        const timePrefix = showTimestamp ? `[${l.timestamp}] ` : "";
        const dataStr = l.data || (showHex ? l.hex : decodeLogEntry(l.hex, l.ascii, encoding));
        const byteLen = l.hex ? l.hex.split(" ").filter(Boolean).length : 0;
        const lenSuffix = l.hex ? ` [${byteLen}B]` : "";
        return `${timePrefix}${l.direction} ${dataStr}${lenSuffix}`;
      }).join("\n");

      await writeTextFile(filePath, content);
    } catch (e) {
      addTextLog("ERROR", `导出失败: ${e}`);
    }
  }, [logs, addTextLog]);

  // 备注：自动滚动日志
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  return {
    logs,
    logContainerRef,
    addLog,
    addTextLog,
    clearLogs,
    exportLogs,
  };
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
