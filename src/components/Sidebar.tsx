import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { SerialConfig, SerialStatus } from "../types/serial";
import type { ModbusRegister, ByteOrderOption } from "../types/modbus";

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 74800, 115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1152000, 1500000, 2000000, 2500000, 3000000, 3500000, 4000000];
const DATA_BITS = [5, 6, 7, 8];
const STOP_BITS = [1, 2];
const PARITIES = ["none", "odd", "even"];

interface SidebarProps {
  ports: string[];
  serialConfig: SerialConfig;
  status: SerialStatus;
  onSerialConfigChange: (config: SerialConfig) => void;
  onRefreshPorts: () => void;
  onTogglePort: () => void;
  onError: (msg: string) => void;
  activeFunction: "serial" | "modbus" | "can";

  // TCP Server Props
  tcpClients?: string[];
  selectedTcpClient?: string;
  onSelectedTcpClientChange?: (client: string) => void;

  // Modbus props
  registers?: ModbusRegister[];
  setRegisters?: React.Dispatch<React.SetStateAction<ModbusRegister[]>>;
  isPolling?: boolean;
  setIsPolling?: (polling: boolean) => void;
  pollInterval?: number;
  setPollInterval?: (interval: number) => void;
  byteOrder?: ByteOrderOption;
  setByteOrder?: (order: ByteOrderOption) => void;
  width?: number;
}

export function Sidebar({
  ports,
  serialConfig,
  status,
  onSerialConfigChange,
  onRefreshPorts,
  onTogglePort,
  onError,
  activeFunction,
  tcpClients = [],
  selectedTcpClient = "all",
  onSelectedTcpClientChange,
  registers = [],
  setRegisters,
  isPolling = false,
  setIsPolling,
  pollInterval = 500,
  setPollInterval,
  byteOrder = "ABCD",
  setByteOrder,
  width = 240,
}: SidebarProps) {
  const { t } = useTranslation();

  // 备注：协议帮助面板折叠状态
  const [showHelp, setShowHelp] = useState(false);

  // Modbus Add Register Form States
  const [newRegName, setNewRegName] = useState("");
  const [newRegSlaveId, setNewRegSlaveId] = useState(1);
  const [newRegAddress, setNewRegAddress] = useState(0);
  const [newRegDataType, setNewRegDataType] = useState<ModbusRegister["dataType"]>("uint16");
  const [newRegFC, setNewRegFC] = useState(3);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDataTypeChange = (type: ModbusRegister["dataType"]) => {
    setNewRegDataType(type);
    if (type === "bool") {
      setNewRegFC(1); // Default to Read Coils for bool
    } else {
      setNewRegFC(3); // Default to Read Holding Registers for numeric
    }
  };

  const handleAddModbusRegister = () => {
    if (!setRegisters) return;

    let count = 1;
    if (newRegDataType === "int32" || newRegDataType === "uint32" || newRegDataType === "float32") {
      count = 2;
    }

    const newReg: ModbusRegister = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
      name: newRegName.trim() || `${newRegDataType.toUpperCase()} @ ${newRegAddress}`,
      slaveId: newRegSlaveId,
      functionCode: newRegFC,
      address: newRegAddress,
      count,
      dataType: newRegDataType,
      value: "-",
      status: "idle",
      enabled: true,
    };

    setRegisters((prev) => [...prev, newReg]);
    setNewRegName("");
  };

  const handleExportJSON = () => {
    if (!registers || registers.length === 0) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(registers, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "modbus_registers.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleImportJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!setRegisters || !e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const list = JSON.parse(event.target?.result as string);
        if (Array.isArray(list)) {
          const normalized = list.map((item: any) => ({
            id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
            name: String(item.name || `${(item.dataType || "uint16").toUpperCase()} @ ${item.address || 0}`),
            slaveId: Number(item.slaveId || 1),
            functionCode: Number(item.functionCode || 3),
            address: Number(item.address || 0),
            count: Number(item.count || 1),
            dataType: (item.dataType || "uint16") as ModbusRegister["dataType"],
            value: "-",
            status: "idle" as const,
            enabled: item.enabled !== false,
          }));
          setRegisters((prev) => [...prev, ...normalized]);
        }
      } catch (err) {
        onError(`导入失败: ${err}`);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleClearAll = () => {
    if (setRegisters && window.confirm(t("serial.confirmClear", { defaultValue: "确定要清空所有寄存器监控行吗？" }))) {
      setRegisters([]);
    }
  };

  // 连接/断开按钮文案与可用性
  const getConnectBtnText = () => {
    if (status.connected) return t("serial.disconnect", { defaultValue: "断开" });
    switch (serialConfig.mode) {
      case "serial": return t("serial.connect", { defaultValue: "打开串口" });
      case "udp": return t("serial.connectUdp", { defaultValue: "打开接口" });
      case "tcp_client": return t("serial.connectTcpClient", { defaultValue: "连接服务器" });
      case "tcp_server": return t("serial.connectTcpServer", { defaultValue: "启动监听" });
      default: return t("serial.connect", { defaultValue: "连接" });
    }
  };

  const isConnectDisabled = () => {
    if (status.connected) return false;
    switch (serialConfig.mode) {
      case "serial": return !serialConfig.port_name;
      case "udp": return !serialConfig.udp_remote_ip || !serialConfig.udp_remote_port || !serialConfig.udp_local_port;
      case "tcp_client": return !serialConfig.tcp_client_ip || !serialConfig.tcp_client_port;
      case "tcp_server": return !serialConfig.tcp_server_port;
      default: return true;
    }
  };

  return (
    <aside className="sidebar" style={{ width: `${width}px`, minWidth: `${width}px` }}>
      {/* ========== 全局固定：物理接口配置与连接控制 ========== */}
      <section className="panel">
        <h3>{t("serial.connectionTitle", { defaultValue: "连接控制" })}</h3>

        {/* 数据接口选择 */}
        <div className="form-group">
          <label>{t("serial.dataInterface", { defaultValue: "数据接口" })}</label>
          <div style={{ color: "var(--text-muted)", fontSize: "11px", marginBottom: "6px" }}>
            {t("serial.dataInterfaceSub", { defaultValue: "与下位机通信的物理接口" })}
          </div>
          <select
            value={serialConfig.mode || "serial"}
            onChange={(e) => onSerialConfigChange({ ...serialConfig, mode: e.target.value })}
            disabled={status.connected}
            style={{ opacity: status.connected ? 0.7 : 1, cursor: status.connected ? "not-allowed" : "pointer" }}
            title={t("serial.dataInterfaceTip", { defaultValue: "选择数据传输物理接口" })}
          >
            <option value="serial">{t("serial.dataInterfaceSerial", { defaultValue: "串口" })}</option>
            <option value="udp">UDP</option>
            <option value="tcp_client">{t("serial.dataInterfaceTcpClient", { defaultValue: "TCP客户端" })}</option>
            <option value="tcp_server">{t("serial.dataInterfaceTcpServer", { defaultValue: "TCP服务端" })}</option>
          </select>
        </div>

        {/* 串口参数 */}
        {serialConfig.mode === "serial" && (
          <>
            <div className="form-group">
              <label>{t("serial.port", { defaultValue: "端口号" })}</label>
              <div className="port-row">
                <select
                  value={serialConfig.port_name}
                  onChange={(e) => onSerialConfigChange({ ...serialConfig, port_name: e.target.value })}
                  title={t("serial.portSelectTip", { defaultValue: "选择要连接的串口设备端口号" })}
                >
                  {ports.length === 0 && <option value="">{t("serial.noPorts", { defaultValue: "无可用串口" })}</option>}
                  {ports.map((p) => (<option key={p} value={p}>{p}</option>))}
                </select>
                <button
                  className="btn-refresh"
                  onClick={onRefreshPorts}
                  title={t("serial.refreshTip", { defaultValue: "扫描并刷新可用串口列表" })}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 4v6h-6" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>{t("serial.baudRate", { defaultValue: "波特率" })}</label>
              <select
                value={serialConfig.baud_rate}
                onChange={(e) => onSerialConfigChange({ ...serialConfig, baud_rate: Number(e.target.value) })}
                title={t("serial.baudRateTip", { defaultValue: "选择串口通信波特率" })}
              >
                {BAUD_RATES.map((r) => (<option key={r} value={r}>{r}</option>))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group"><label>{t("serial.dataBits", { defaultValue: "数据位" })}</label>
                <select
                  value={serialConfig.data_bits}
                  onChange={(e) => onSerialConfigChange({ ...serialConfig, data_bits: Number(e.target.value) })}
                  title={t("serial.dataBitsTip", { defaultValue: "通信数据位，默认通常为 8" })}
                >
                  {DATA_BITS.map((d) => (<option key={d} value={d}>{d}</option>))}
                </select>
              </div>
              <div className="form-group"><label>{t("serial.stopBits", { defaultValue: "停止位" })}</label>
                <select
                  value={serialConfig.stop_bits}
                  onChange={(e) => onSerialConfigChange({ ...serialConfig, stop_bits: Number(e.target.value) })}
                  title={t("serial.stopBitsTip", { defaultValue: "通信停止位，默认通常为 1" })}
                >
                  {STOP_BITS.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
              </div>
              <div className="form-group"><label>{t("serial.parity", { defaultValue: "校验" })}</label>
                <select
                  value={serialConfig.parity}
                  onChange={(e) => onSerialConfigChange({ ...serialConfig, parity: e.target.value })}
                  title={t("serial.parityTip", { defaultValue: "奇偶校验方式，默认通常为无校验 (none)" })}
                >
                  {PARITIES.map((p) => (
                    <option key={p} value={p}>{t(`serial.parity${p.charAt(0).toUpperCase() + p.slice(1)}`, { defaultValue: p })}</option>
                  ))}
                </select>
              </div>
            </div>
          </>
        )}

        {/* UDP 参数 */}
        {serialConfig.mode === "udp" && (
          <>
            <div className="form-group">
              <label>{t("serial.udpRemoteIp", { defaultValue: "远程IP" })}</label>
              <input type="text" placeholder="127.0.0.1" value={serialConfig.udp_remote_ip} onChange={(e) => onSerialConfigChange({ ...serialConfig, udp_remote_ip: e.target.value })} disabled={status.connected} />
            </div>
            <div className="form-group">
              <label>{t("serial.udpRemotePort", { defaultValue: "远程端口" })}</label>
              <input type="number" placeholder="1346" value={serialConfig.udp_remote_port} onChange={(e) => onSerialConfigChange({ ...serialConfig, udp_remote_port: Number(e.target.value) })} disabled={status.connected} />
            </div>
            <div className="form-group">
              <label>{t("serial.udpLocalPort", { defaultValue: "本地端口" })}</label>
              <input type="number" placeholder="1347" value={serialConfig.udp_local_port} onChange={(e) => onSerialConfigChange({ ...serialConfig, udp_local_port: Number(e.target.value) })} disabled={status.connected} />
            </div>
          </>
        )}

        {/* TCP 客户端参数 */}
        {serialConfig.mode === "tcp_client" && (
          <>
            <div className="form-group">
              <label>{t("serial.tcpServerIp", { defaultValue: "服务器IP" })}</label>
              <input type="text" placeholder="127.0.0.1" value={serialConfig.tcp_client_ip} onChange={(e) => onSerialConfigChange({ ...serialConfig, tcp_client_ip: e.target.value })} disabled={status.connected} />
            </div>
            <div className="form-group">
              <label>{t("serial.tcpNetworkPort", { defaultValue: "网络端口" })}</label>
              <input type="number" placeholder="1346" value={serialConfig.tcp_client_port} onChange={(e) => onSerialConfigChange({ ...serialConfig, tcp_client_port: Number(e.target.value) })} disabled={status.connected} />
            </div>
            <div className="form-group">
              <label>{t("serial.tcpHandshake", { defaultValue: "握手数据" })}</label>
              <input type="text" placeholder="例如: plot0" value={serialConfig.tcp_client_handshake} onChange={(e) => onSerialConfigChange({ ...serialConfig, tcp_client_handshake: e.target.value })} disabled={status.connected} />
            </div>
          </>
        )}

        {/* TCP 服务端参数 */}
        {serialConfig.mode === "tcp_server" && (
          <>
            <div className="form-group">
              <label>{t("serial.tcpListenPort", { defaultValue: "监听端口" })}</label>
              <input type="number" placeholder="1347" value={serialConfig.tcp_server_port} onChange={(e) => onSerialConfigChange({ ...serialConfig, tcp_server_port: Number(e.target.value) })} disabled={status.connected} />
            </div>
            <div className="form-group">
              <label>{t("serial.tcpConnectionCount", { defaultValue: "连接数量" })}</label>
              <div style={{ padding: "8px 12px", borderRadius: "6px", background: "var(--bg-tertiary)", border: "1px solid var(--border)", color: "var(--text-primary)", fontWeight: "bold", fontSize: "14px" }}>
                {tcpClients.length}
              </div>
            </div>
            <div className="form-group">
              <label>{t("serial.tcpCurrentConnection", { defaultValue: "当前连接" })}</label>
              <select
                value={selectedTcpClient}
                onChange={(e) => onSelectedTcpClientChange && onSelectedTcpClientChange(e.target.value)}
                disabled={!status.connected || tcpClients.length === 0}
                title="选择向哪一个客户端发送数据"
              >
                <option value="all">{tcpClients.length > 0 ? "全部 (All)" : "none"}</option>
                {tcpClients.map((client) => (
                  <option key={client} value={client}>{client}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* 重连状态提示 */}
        {status.reconnecting && (
          <div style={{ padding: "6px 10px", borderRadius: "6px", background: "rgba(255,180,0,0.15)", border: "1px solid rgba(255,180,0,0.3)", color: "var(--warning, #f0b020)", fontSize: "11px", fontWeight: 600, marginBottom: "8px", textAlign: "center" }}>
            ⟳ {t("serial.reconnecting", { defaultValue: "正在尝试重连..." })}
          </div>
        )}

        {/* 全局连接/断开按钮 */}
        <button
          className={`btn-connect ${status.connected ? "disconnect" : ""}`}
          onClick={onTogglePort}
          disabled={isConnectDisabled()}
          title={status.connected ? t("serial.disconnectTip", { defaultValue: "断开当前连接" }) : t("serial.connectTip", { defaultValue: "建立连接" })}
        >
          {getConnectBtnText()}
        </button>
      </section>

      {/* ========== 功能标签页专属内容 ========== */}
      {activeFunction === "serial" ? (
        <>
          {/* 协议与数据引擎 */}
          <section className="panel">
            <h3>{t("serial.protocolTitle", { defaultValue: "协议与连接" })}</h3>

            {/* 数据引擎 */}
            <div className="form-group">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
                <label style={{ margin: 0 }}>{t("serial.dataEngine", { defaultValue: "数据引擎" })}</label>
                <button
                  className={`btn-help-toggle ${showHelp ? "active" : ""}`}
                  onClick={() => setShowHelp(!showHelp)}
                  title={t("serial.toggleHelp", { defaultValue: "显示/隐藏协议说明" })}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: showHelp ? "var(--accent)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: "11px",
                    padding: "2px 4px",
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    fontWeight: 600,
                  }}
                >
                  {showHelp ? t("serial.collapseHelp", { defaultValue: "收起说明" }) : t("serial.showHelp", { defaultValue: "查看说明 ?" })}
                </button>
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: "11px", marginBottom: "6px" }}>
                {t("serial.clickQuestionMark", { defaultValue: "点击问号：前往详细文档" })}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <select
                  value={serialConfig.protocol || "FireWater"}
                  onChange={(e) => onSerialConfigChange({ ...serialConfig, protocol: e.target.value })}
                  title={t("serial.protocolSelectTip", { defaultValue: "选择波形/日志数据解析协议引擎" })}
                  style={{ flex: 1, margin: 0 }}
                >
                  <option value="RawData">RawData</option>
                  <option value="FireWater">FireWater</option>
                  <option value="JustFloat">JustFloat</option>
                </select>
                <a
                  href="https://github.com/Z1R343L-D77/OxideSerial#readme"
                  onClick={(e) => {
                    e.preventDefault();
                    invoke("open_url", { url: "https://github.com/Z1R343L-D77/OxideSerial#readme" })
                      .catch(err => console.error("Failed to open URL:", err));
                  }}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-docs-question"
                  title={t("serial.docsLinkTip", { defaultValue: "前往详细文档" })}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "32px",
                    height: "32px",
                    borderRadius: "6px",
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                    textDecoration: "none",
                    fontWeight: "bold",
                    fontSize: "14px",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-tertiary)"; }}
                >
                  ?
                </a>
              </div>
            </div>

            {/* 协议说明 Card */}
            {showHelp && (
              <div className="protocol-help-card">
                {serialConfig.protocol === "RawData" && (
                  <div className="protocol-info-box">
                    <div className="protocol-info-title">RawData</div>
                    <div className="protocol-info-section">
                      <strong>{t("serial.dataFormat", { defaultValue: "数据格式:" })}</strong>
                      <p>{t("serial.rawDataDesc", { defaultValue: "如果您只把OxideSerial当成串口调试助手，不做任何采样数据解析，请务必使用本协议。" })}</p>
                    </div>
                    <div className="protocol-info-section">
                      <strong>{t("serial.example", { defaultValue: "例子:" })}</strong>
                      <p>{t("serial.rawDataExample", { defaultValue: "RawData不做采样数据解析。RawData协议适用于不需要解析数据，仅仅查看字节流的需求。" })}</p>
                    </div>
                  </div>
                )}
                {serialConfig.protocol === "JustFloat" && (
                  <div className="protocol-info-box">
                    <div className="protocol-info-title">JustFloat</div>
                    <div className="protocol-info-section">
                      <strong>{t("serial.dataFormat", { defaultValue: "数据格式:" })}</strong>
                      <pre className="code-block">
                        {`#define CH_COUNT <N>
struct Frame {
    float fdata[CH_COUNT];
    unsigned char tail[4]{0x00, 0x00, 0x80, 0x7f};
};`}
                      </pre>
                      <p>• <code>fdata</code> {t("serial.justFloatFdataDesc", { defaultValue: "为小端浮点数组，里面放着需要发送的" })} <code>CH_COUNT</code> {t("serial.justFloatChannelsDesc", { defaultValue: "个通道。" })}</p>
                      <p>• <code>tail</code> {t("serial.justFloatTailDesc", { defaultValue: "为帧尾。" })}</p>
                    </div>
                    <div className="protocol-info-section">
                      <strong>{t("serial.example", { defaultValue: "例子:" })}</strong>
                      <pre className="code-block">
                        {`float ch[4];
ch[0] = sin(t);
ch[1] = sin(2*t);
ch[2] = sin(3*t);
ch[3] = sin(4*t);
write((char *)ch, sizeof(float) * 4);

char tail[4] = {0x00, 0x00, 0x80, 0x7f};
write(tail, 4);`}
                      </pre>
                    </div>
                  </div>
                )}
                {serialConfig.protocol === "FireWater" && (
                  <div className="protocol-info-box">
                    <div className="protocol-info-title">FireWater</div>
                    <div className="protocol-info-section">
                      <strong>{t("serial.dataFormat", { defaultValue: "数据格式:" })}</strong>
                      <p><code>"&lt;any&gt;:ch0,ch1,ch2,...,chN\n"</code></p>
                      <p>{t("serial.or", { defaultValue: "或" })}</p>
                      <p><code>"ch0,ch1,ch2,...,chN\n"</code></p>
                    </div>
                    <div className="protocol-info-section">
                      <strong>{t("serial.example", { defaultValue: "例子:" })}</strong>
                      <pre className="code-block">
                        {`printf("samples: 1.1, 3.2, -0.6, -0.9\\n")
` + t("serial.or", { defaultValue: "或" }) + `
printf("1.1, 3.2, -0.6, -0.9\\n")`}
                      </pre>
                      <p className="warning-text">• {t("serial.fireWaterWarning", { defaultValue: "注意：FireWater遇到换行才会打印数据，很多新用户在这里产生疑惑。" })}</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      ) : activeFunction === "modbus" ? (
        <>
          {/* Polling Configuration Panel */}
          <section className="panel">
            <h3>{t("modbus.pollConfig", { defaultValue: "轮询配置" })}</h3>
            <div className="form-group">
              <label>{t("modbus.pollInterval", { defaultValue: "扫频间隔 (ms)" })}</label>
              <input
                type="number"
                min={50}
                max={10000}
                value={pollInterval}
                onChange={(e) => setPollInterval && setPollInterval(Math.max(50, Number(e.target.value)))}
                disabled={isPolling}
                title={t("modbus.pollIntervalTip", { defaultValue: "设置 Modbus 主站轮询所有寄存器的时间周期 (ms)" })}
              />
            </div>
            <div className="form-group">
              <label>{t("modbus.byteOrder", { defaultValue: "32位字节序 (Swap)" })}</label>
              <select
                value={byteOrder}
                onChange={(e) => setByteOrder && setByteOrder(e.target.value as ByteOrderOption)}
                disabled={isPolling}
                title={t("modbus.byteOrderTip", { defaultValue: "设定 32 位双字或浮点数在串口传输中的高低字节排列顺序" })}
              >
                <option value="ABCD">ABCD (Big Endian)</option>
                <option value="CDAB">CDAB (Word Swap)</option>
                <option value="BADC">BADC (Byte Swap)</option>
                <option value="DCBA">DCBA (Little Endian)</option>
              </select>
            </div>
            <button
              className={`btn-connect ${isPolling ? "disconnect" : ""}`}
              onClick={() => setIsPolling && setIsPolling(!isPolling)}
              disabled={!status.connected}
              title={isPolling ? t("modbus.stopPollTip", { defaultValue: "停止当前对 Modbus 寄存器的定时轮询" }) : t("modbus.startPollTip", { defaultValue: "启动定时轮询，按设定扫频间隔自动读取各个寄存器值" })}
              style={{
                background: isPolling ? "var(--danger)" : "var(--accent)",
                color: "var(--bg-primary)",
                fontWeight: 600,
                marginTop: "10px",
              }}
            >
              {isPolling ? t("modbus.stopPoll", { defaultValue: "停止轮询" }) : t("modbus.startPoll", { defaultValue: "开始轮询" })}
            </button>
          </section>

          {/* Add Register Panel */}
          <section className="panel">
            <h3>{t("modbus.addRegister", { defaultValue: "添加寄存器" })}</h3>
            <div className="form-group">
              <label>{t("modbus.regName", { defaultValue: "寄存器别名" })}</label>
              <input
                type="text"
                placeholder={t("modbus.regPlaceholder", { defaultValue: "例如: 电机转速" })}
                value={newRegName}
                onChange={(e) => setNewRegName(e.target.value)}
                title={t("modbus.regNameTip", { defaultValue: "为寄存器分配一个易记的友好别名" })}
              />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>{t("modbus.slaveId", { defaultValue: "从站 ID" })}</label>
                <input
                  type="number"
                  min={1}
                  max={247}
                  value={newRegSlaveId}
                  onChange={(e) => setNewRegSlaveId(Number(e.target.value))}
                  title={t("modbus.slaveIdTip", { defaultValue: "设置目标从设备的设备站地址/从机号 (1-247)" })}
                />
              </div>
              <div className="form-group">
                <label>{t("modbus.dataType", { defaultValue: "数据类型" })}</label>
                <select
                  value={newRegDataType}
                  onChange={(e) => handleDataTypeChange(e.target.value as ModbusRegister["dataType"])}
                  title={t("modbus.dataTypeTip", { defaultValue: "选择寄存器对应的物理数据解析格式（如16位单字、32位双字或单精度浮点）" })}
                >
                  <option value="bool">bool (开关)</option>
                  <option value="int16">int16 (单字)</option>
                  <option value="uint16">uint16 (单字)</option>
                  <option value="int32">int32 (双字)</option>
                  <option value="uint32">uint32 (双字)</option>
                  <option value="float32">float32 (浮点)</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>{t("modbus.functionCode", { defaultValue: "只读功能码" })}</label>
                <select
                  value={newRegFC}
                  onChange={(e) => setNewRegFC(Number(e.target.value))}
                  title={t("modbus.functionCodeTip", { defaultValue: "指定读取此寄存器点所使用的 Modbus 只读功能码" })}
                >
                  {newRegDataType === "bool" ? (
                    <>
                      <option value={1}>01 (Read Coils)</option>
                      <option value={2}>02 (Read Discrete Inputs)</option>
                    </>
                  ) : (
                    <>
                      <option value={3}>03 (Read Holding Registers)</option>
                      <option value={4}>04 (Read Input Registers)</option>
                    </>
                  )}
                </select>
              </div>
              <div className="form-group">
                <label>{t("modbus.regAddr", { defaultValue: "寄存器地址" })}</label>
                <input
                  type="number"
                  min={0}
                  max={65535}
                  value={newRegAddress}
                  onChange={(e) => setNewRegAddress(Number(e.target.value))}
                  title={t("modbus.regAddrTip", { defaultValue: "寄存器寄存地址偏移量，物理起始地址，范围为 0-65535" })}
                />
              </div>
            </div>
            <button
              className="btn-modbus"
              onClick={handleAddModbusRegister}
              title={t("modbus.addRegBtnTip", { defaultValue: "将该寄存器读取行配置追加添加到下方的监控列表中" })}
              style={{ marginTop: "10px" }}
            >
              + 添加到 M表
            </button>
          </section>

          {/* Batch operations */}
          <section className="panel" style={{ background: "rgba(255, 255, 255, 0.02)" }}>
            <h3>{t("modbus.batchOps", { defaultValue: "批量配置管理" })}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "8px" }}>
              <button
                className="btn-secondary"
                onClick={handleExportJSON}
                disabled={registers.length === 0}
                style={{ padding: "8px" }}
                title={t("modbus.exportJSONTip", { defaultValue: "将当前 M 表所有的寄存器项配置导出为本地 JSON 配置文件进行保存" })}
              >
                导出 JSON
              </button>
              <button
                className="btn-secondary"
                onClick={() => fileInputRef.current?.click()}
                style={{ padding: "8px" }}
                title={t("modbus.importJSONTip", { defaultValue: "导入先前导出的 JSON 配置文件，批量恢复寄存器监控行" })}
              >
                导入 JSON
              </button>
              <input
                type="file"
                accept=".json"
                ref={fileInputRef}
                onChange={handleImportJSON}
                style={{ display: "none" }}
              />
            </div>
            <button
              className="btn-danger-outline"
              onClick={handleClearAll}
              disabled={registers.length === 0}
              style={{ width: "100%", marginTop: "8px", padding: "8px" }}
              title={t("modbus.clearAllBtnTip", { defaultValue: "删除下方监控看板中的所有寄存器行" })}
            >
              清空 M表
            </button>
          </section>
        </>
      ) : (
        <section className="panel">
          <h3>{t("serial.canTitle", { defaultValue: "CAN总线监测" })}</h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "12px", margin: "10px 0" }}>
            {t("serial.canDesc", { defaultValue: "当前功能规划中，后续将加入此监测表。" })}
          </p>
          <div style={{ opacity: 0.3, pointerEvents: "none" }}>
            <div className="form-group">
              <label>{t("serial.canBaudRate", { defaultValue: "波特率" })}</label>
              <select defaultValue="250k"><option>250k</option></select>
            </div>
            <button className="btn-connect" style={{ marginTop: "10px" }}>{t("serial.canConnect", { defaultValue: "打开CAN通道" })}</button>
          </div>
        </section>
      )}
    </aside>
  );
}
