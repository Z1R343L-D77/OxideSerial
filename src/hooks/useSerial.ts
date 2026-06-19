import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { SerialConfig, SerialStatus, TerminalData } from "../types/serial";

export function useSerial(
  addLog: (direction: string, hex: string, ascii: string) => void,
  addTextLog: (direction: string, text: string) => void,
) {
  const { t } = useTranslation();

  // 备注：通过 ref 读取回调，避免 locale 变化重建事件监听器
  const addLogRef = useRef<(direction: string, hex: string, ascii: string, timestamp?: string) => void>(addLog);
  const addTextLogRef = useRef(addTextLog);
  useEffect(() => { addLogRef.current = addLog; }, [addLog]);
  useEffect(() => { addTextLogRef.current = addTextLog; }, [addTextLog]);

  const [ports, setPorts] = useState<string[]>([]);
  const [serialConfig, setSerialConfig] = useState<SerialConfig>({
    port_name: "",
    baud_rate: 115200,
    data_bits: 8,
    stop_bits: 1,
    parity: "none",
    protocol: "FireWater",
  });
  const [status, setStatus] = useState<SerialStatus>({
    connected: false,
    port_name: "",
    baud_rate: 0,
  });
  const [byteStats, setByteStats] = useState<[number, number]>([0, 0]);

  // 监听 protocol 变更以同步到后端（支持动态切换协议）
  useEffect(() => {
    if (status.connected) {
      invoke("set_protocol", { protocol: serialConfig.protocol })
        .catch((e) => addTextLog("ERROR", `同步协议至后端失败: ${e}`));
    }
  }, [serialConfig.protocol, status.connected, addTextLog]);

  // 备注：监听串口数据事件（通过 ref 读取回调，不随 locale 重建）
  useEffect(() => {
    const unlisten1 = listen<TerminalData>("serial-data", (event) => {
      const d = event.payload;
      addLogRef.current(d.direction, d.hex, d.ascii, d.timestamp);
    });

    // R1: 串口断开检测
    const unlisten3 = listen<string>("serial-error", (event) => {
      addTextLogRef.current("ERROR", `串口错误: ${event.payload}`);
      setStatus({ connected: false, port_name: "", baud_rate: 0 });
      void invoke("close_port").catch(() => { });
    });

    return () => {
      void unlisten1.then((fn) => fn());
      void unlisten3.then((fn) => fn());
    };
  }, []);

  // M10: 定时轮询 RX/TX 字节统计
  useEffect(() => {
    if (!status.connected) {
      setByteStats([0, 0]);
      return;
    }
    const timer = setInterval(() => {
      invoke<[number, number]>("get_byte_stats").then(setByteStats).catch(() => { });
    }, 500);
    return () => clearInterval(timer);
  }, [status.connected]);

  // 备注：刷新串口列表
  const refreshPorts = useCallback(async () => {
    try {
      const portList = await invoke<string[]>("list_ports");
      setPorts(portList);
      if (portList.length > 0) {
        setSerialConfig((prev) => prev.port_name ? prev : { ...prev, port_name: portList[0] });
      }
    } catch (e) {
      addTextLog("ERROR", `${t("serial.refreshFail", { defaultValue: "刷新串口失败" })}: ${e}`);
    }
  }, [addTextLog, t]);

  // 备注：打开/关闭串口
  const togglePort = useCallback(async () => {
    if (status.connected) {
      try {
        await invoke("close_port");
        setStatus({ connected: false, port_name: "", baud_rate: 0 });
        addTextLog("INFO", t("serial.portClosed", { defaultValue: "串口已关闭" }));
      } catch (e) {
        addTextLog("ERROR", `${e}`);
      }
    } else {
      try {
        const result = await invoke<SerialStatus>("open_port", { config: serialConfig });
        setStatus(result);
        addTextLog("INFO", `${t("status.connected", { defaultValue: "已连接" })}: ${serialConfig.port_name} @ ${serialConfig.baud_rate}`);
      } catch (e) {
        addTextLog("ERROR", `${e}`);
      }
    }
  }, [status.connected, serialConfig, addTextLog, t]);

  // 备注：初始化刷新串口列表
  const refreshPortsRef = useRef(refreshPorts);
  useEffect(() => { refreshPortsRef.current = refreshPorts; }, [refreshPorts]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshPortsRef.current(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return {
    ports,
    serialConfig,
    setSerialConfig,
    status,
    byteStats,
    refreshPorts,
    togglePort,
  };
}
