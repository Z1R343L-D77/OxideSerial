import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { SerialConfig, SerialStatus, TerminalData, SerialPortInfoDetailed } from "../types/serial";

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

  const [ports, setPorts] = useState<SerialPortInfoDetailed[]>([]);
  const portsRef = useRef(ports);
  useEffect(() => {
    portsRef.current = ports;
  }, [ports]);
  const [serialConfig, setSerialConfigRaw] = useState<SerialConfig>(() => {
    const defaults: SerialConfig = {
      mode: "serial",
      port_name: "",
      baud_rate: 115200,
      data_bits: 8,
      stop_bits: 1,
      parity: "none",
      protocol: "FireWater",
      udp_remote_ip: "127.0.0.1",
      udp_remote_port: 1346,
      udp_local_port: 1347,
      tcp_client_ip: "127.0.0.1",
      tcp_client_port: 1346,
      tcp_client_handshake: "",
      tcp_server_port: 1347,
    };
    try {
      const saved = localStorage.getItem("serial-config");
      if (saved) {
        const parsed = JSON.parse(saved);
        // 备注：port_name 不持久化，因为物理串口可能已变化
        return { ...defaults, ...parsed, port_name: "" };
      }
    } catch { /* ignore */ }
    return defaults;
  });

  // 备注：包装 setSerialConfig 自动持久化
  const setSerialConfig = useCallback((updater: SerialConfig | ((prev: SerialConfig) => SerialConfig)) => {
    setSerialConfigRaw((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      try {
        // 备注：排除 port_name 持久化
        const { port_name: _, ...rest } = next;
        localStorage.setItem("serial-config", JSON.stringify(rest));
      } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [status, setStatus] = useState<SerialStatus>({
    connected: false,
    port_name: "",
    baud_rate: 0,
    mode: "serial",
  });
  const connectedRef = useRef(status.connected);
  useEffect(() => {
    connectedRef.current = status.connected;
  }, [status.connected]);
  const [byteStats, setByteStats] = useState<[number, number]>([0, 0]);
  const [tcpClients, setTcpClients] = useState<string[]>([]);
  const [selectedTcpClient, setSelectedTcpClient] = useState<string>("all");

  // 监听 protocol 变更以同步到后端（支持动态切换协议）
  useEffect(() => {
    if (status.connected) {
      invoke("set_protocol", { protocol: serialConfig.protocol })
        .catch((e) => addTextLog("ERROR", `同步协议至后端失败: ${e}`));
    }
  }, [serialConfig.protocol, status.connected, addTextLog]);

  // 同步 TCP Server 目标 client
  useEffect(() => {
    if (status.connected && status.mode === "tcp_server") {
      invoke("set_active_tcp_client", { clientAddr: selectedTcpClient === "all" ? null : selectedTcpClient })
        .catch((e) => addTextLog("ERROR", `同步发送目标客户端失败: ${e}`));
    }
  }, [selectedTcpClient, status.connected, status.mode, addTextLog]);

  // 备注：监听数据与连接事件
  useEffect(() => {
    const unlisten1 = listen<TerminalData>("serial-data", (event) => {
      const d = event.payload;
      addLogRef.current(d.direction, d.hex, d.ascii, d.timestamp);
    });

    const unlisten3 = listen<string>("serial-error", (event) => {
      addTextLogRef.current("ERROR", `连接错误: ${event.payload}`);
      setStatus({ connected: false, port_name: "", baud_rate: 0, mode: "serial" });
      setTcpClients([]);
      setSelectedTcpClient("all");
      void invoke("close_port").catch(() => { });
    });

    const unlistenTcp = listen<string[]>("tcp-clients-changed", (event) => {
      setTcpClients(event.payload);
    });

    // 备注：TCP 客户端自动重连事件
    const unlistenReconnecting = listen<string>("serial-reconnecting", (event) => {
      addTextLogRef.current("INFO", `${event.payload}`);
      setStatus((prev) => ({ ...prev, reconnecting: true }));
    });

    const unlistenReconnected = listen<string>("serial-reconnected", (event) => {
      addTextLogRef.current("INFO", `${event.payload}`);
      setStatus((prev) => ({ ...prev, connected: true, reconnecting: false }));
    });

    return () => {
      void unlisten1.then((fn) => fn());
      void unlisten3.then((fn) => fn());
      void unlistenTcp.then((fn) => fn());
      void unlistenReconnecting.then((fn) => fn());
      void unlistenReconnected.then((fn) => fn());
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
  const refreshPorts = useCallback(async (isSilent = false) => {
    try {
      const portList = await invoke<SerialPortInfoDetailed[]>("list_ports");
      const portNames = portList.map((p) => p.port_name);
      
      const sortedPrev = [...portsRef.current].map((p) => p.port_name).sort();
      const sortedNew = [...portNames].sort();
      const isSame = sortedPrev.length === sortedNew.length && sortedPrev.every((val, index) => val === sortedNew[index]);
      
      if (!isSame) {
        setPorts(portList);
        
        setSerialConfig((prevConfig) => {
          if (connectedRef.current) {
            return prevConfig;
          }
          if (prevConfig.port_name && portNames.includes(prevConfig.port_name)) {
            return prevConfig;
          }
          if (portList.length > 0) {
            return { ...prevConfig, port_name: portList[0].port_name };
          }
          return { ...prevConfig, port_name: "" };
        });
      }
    } catch (e) {
      if (!isSilent) {
        addTextLog("ERROR", `${t("serial.refreshFail", { defaultValue: "刷新串口失败" })}: ${e}`);
      }
    }
  }, [addTextLog, t, setSerialConfig]);

  // 备注：打开/关闭连接
  const togglePort = useCallback(async () => {
    if (status.connected) {
      try {
        await invoke("close_port");
        setStatus({ connected: false, port_name: "", baud_rate: 0, mode: "serial" });
        setTcpClients([]);
        setSelectedTcpClient("all");
        addTextLog("INFO", t("serial.portClosed", { defaultValue: "连接已关闭" }));
      } catch (e) {
        addTextLog("ERROR", `${e}`);
      }
    } else {
      try {
        const result = await invoke<SerialStatus>("open_port", { config: serialConfig });
        setStatus(result);
        if (serialConfig.mode === "serial") {
          addTextLog("INFO", `${t("status.connected", { defaultValue: "已连接" })}: ${serialConfig.port_name} @ ${serialConfig.baud_rate}`);
        } else if (serialConfig.mode === "udp") {
          addTextLog("INFO", `${t("status.connected", { defaultValue: "UDP 绑定成功" })}: 远程 ${serialConfig.udp_remote_ip}:${serialConfig.udp_remote_port} | 本地端口 :${serialConfig.udp_local_port}`);
        } else if (serialConfig.mode === "tcp_client") {
          addTextLog("INFO", `${t("status.connected", { defaultValue: "TCP 客户端连接成功" })}: ${serialConfig.tcp_client_ip}:${serialConfig.tcp_client_port}`);
        } else if (serialConfig.mode === "tcp_server") {
          addTextLog("INFO", `${t("status.connected", { defaultValue: "TCP 服务端启动成功" })}: 监听 :${serialConfig.tcp_server_port}`);
        }
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

  // 备注：监听串口设备变更事件，自动更新列表并实现自动选择
  useEffect(() => {
    const unlistenPromise = listen<SerialPortInfoDetailed[]>("ports-changed", (event) => {
      const portList = event.payload;
      const portNames = portList.map((p) => p.port_name);
      
      const sortedPrev = [...portsRef.current].map((p) => p.port_name).sort();
      const sortedNew = [...portNames].sort();
      const isSame = sortedPrev.length === sortedNew.length && sortedPrev.every((val, index) => val === sortedNew[index]);
      
      if (!isSame) {
        setPorts(portList);
        
        // 检测新插入的串口以实现自动选择
        const prevPortNames = portsRef.current.map((p) => p.port_name);
        const addedPorts = portNames.filter(p => !prevPortNames.includes(p));
        
        setSerialConfig((prevConfig) => {
          if (connectedRef.current) {
            return prevConfig;
          }
          if (addedPorts.length > 0) {
            return { ...prevConfig, port_name: addedPorts[0] };
          }
          if (prevConfig.port_name && portNames.includes(prevConfig.port_name)) {
            return prevConfig;
          }
          if (portList.length > 0) {
            return { ...prevConfig, port_name: portList[0].port_name };
          }
          return { ...prevConfig, port_name: "" };
        });
      }
    });

    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, [setSerialConfig]);

  return {
    ports,
    serialConfig,
    setSerialConfig,
    status,
    byteStats,
    tcpClients,
    selectedTcpClient,
    setSelectedTcpClient,
    refreshPorts,
    togglePort,
  };
}
