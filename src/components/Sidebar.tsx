import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
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

  return (
    <aside className="sidebar" style={{ width: `${width}px`, minWidth: `${width}px` }}>
      {activeFunction === "serial" ? (
        <>
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
              <select
                value={serialConfig.protocol || "FireWater"}
                onChange={(e) => onSerialConfigChange({ ...serialConfig, protocol: e.target.value })}
              >
                <option value="RawData">RawData</option>
                <option value="FireWater">FireWater</option>
                <option value="JustFloat">JustFloat</option>
              </select>
            </div>

            {/* 协议说明 Card */}
            {showHelp && (
              <div className="protocol-help-card">
                {serialConfig.protocol === "RawData" && (
                  <div className="protocol-info-box">
                    <div className="protocol-info-title">RawData</div>
                    <div className="protocol-info-section">
                      <strong>数据格式:</strong>
                      <p>如果您只把OxideSerial当成串口调试助手，不做任何采样数据解析，请务必使用本协议。</p>
                    </div>
                    <div className="protocol-info-section">
                      <strong>例子:</strong>
                      <p>RawData不做采样数据解析。RawData协议适用于不需要解析数据，仅仅查看字节流的需求。</p>
                    </div>
                  </div>
                )}
                {serialConfig.protocol === "JustFloat" && (
                  <div className="protocol-info-box">
                    <div className="protocol-info-title">JustFloat</div>
                    <div className="protocol-info-section">
                      <strong>数据格式:</strong>
                      <pre className="code-block">
{`#define CH_COUNT <N>
struct Frame {
    float fdata[CH_COUNT];
    unsigned char tail[4]{0x00, 0x00, 0x80, 0x7f};
};`}
                      </pre>
                      <p>• <code>fdata</code> 为小端浮点数组，里面放着需要发送的 <code>CH_COUNT</code> 个通道。</p>
                      <p>• <code>tail</code> 为帧尾。</p>
                    </div>
                    <div className="protocol-info-section">
                      <strong>例子:</strong>
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
                      <strong>数据格式:</strong>
                      <p><code>"&lt;any&gt;:ch0,ch1,ch2,...,chN\n"</code></p>
                      <p>或</p>
                      <p><code>"ch0,ch1,ch2,...,chN\n"</code></p>
                    </div>
                    <div className="protocol-info-section">
                      <strong>例子:</strong>
                      <pre className="code-block">
{`printf("samples: 1.1, 3.2, -0.6, -0.9\\n")
或
printf("1.1, 3.2, -0.6, -0.9\\n")`}
                      </pre>
                      <p className="warning-text">• 注意：FireWater遇到换行才会打印数据，很多新用户在这里产生疑惑。</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 数据接口 */}
            <div className="form-group" style={{ marginTop: "10px" }}>
              <label>{t("serial.dataInterface", { defaultValue: "数据接口" })}</label>
              <select value="serial" disabled style={{ opacity: 0.7, cursor: "not-allowed" }}>
                <option value="serial">{t("serial.dataInterfaceSerial", { defaultValue: "串口" })}</option>
              </select>
            </div>
          </section>

          <section className="panel">
            <h3>{t("serial.paramsTitle", { defaultValue: "串口参数配置" })}</h3>
            <div className="form-group">
              <label>{t("serial.port", { defaultValue: "端口号" })}</label>
              <div className="port-row">
                <select value={serialConfig.port_name} onChange={(e) => onSerialConfigChange({ ...serialConfig, port_name: e.target.value })}>
                  {ports.length === 0 && <option value="">{t("serial.noPorts", { defaultValue: "无可用串口" })}</option>}
                  {ports.map((p) => (<option key={p} value={p}>{p}</option>))}
                </select>
                <button className="btn-refresh" onClick={onRefreshPorts} title={t("serial.refresh", { defaultValue: "刷新" })}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 4v6h-6" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>{t("serial.baudRate", { defaultValue: "波特率" })}</label>
              <select value={serialConfig.baud_rate} onChange={(e) => onSerialConfigChange({ ...serialConfig, baud_rate: Number(e.target.value) })}>
                {BAUD_RATES.map((r) => (<option key={r} value={r}>{r}</option>))}
              </select>
            </div>
            <div className="form-row">
              <div className="form-group"><label>{t("serial.dataBits", { defaultValue: "数据位" })}</label>
                <select value={serialConfig.data_bits} onChange={(e) => onSerialConfigChange({ ...serialConfig, data_bits: Number(e.target.value) })}>
                  {DATA_BITS.map((d) => (<option key={d} value={d}>{d}</option>))}
                </select>
              </div>
              <div className="form-group"><label>{t("serial.stopBits", { defaultValue: "停止位" })}</label>
                <select value={serialConfig.stop_bits} onChange={(e) => onSerialConfigChange({ ...serialConfig, stop_bits: Number(e.target.value) })}>
                  {STOP_BITS.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
              </div>
              <div className="form-group"><label>{t("serial.parity", { defaultValue: "校验" })}</label>
                <select value={serialConfig.parity} onChange={(e) => onSerialConfigChange({ ...serialConfig, parity: e.target.value })}>
                  {PARITIES.map((p) => (
                    <option key={p} value={p}>{t(`serial.parity${p.charAt(0).toUpperCase() + p.slice(1)}`, { defaultValue: p })}</option>
                  ))}
                </select>
              </div>
            </div>
            <button className={`btn-connect ${status.connected ? "disconnect" : ""}`} onClick={onTogglePort} disabled={!serialConfig.port_name}>
              {status.connected ? t("serial.disconnect", { defaultValue: "断开" }) : t("serial.connect", { defaultValue: "打开串口" })}
            </button>
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
              />
            </div>
            <div className="form-group">
              <label>{t("modbus.byteOrder", { defaultValue: "32位字节序 (Swap)" })}</label>
              <select
                value={byteOrder}
                onChange={(e) => setByteOrder && setByteOrder(e.target.value as ByteOrderOption)}
                disabled={isPolling}
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
                />
              </div>
              <div className="form-group">
                <label>{t("modbus.dataType", { defaultValue: "数据类型" })}</label>
                <select
                  value={newRegDataType}
                  onChange={(e) => handleDataTypeChange(e.target.value as ModbusRegister["dataType"])}
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
                <select value={newRegFC} onChange={(e) => setNewRegFC(Number(e.target.value))}>
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
                />
              </div>
            </div>
            <button
              className="btn-modbus"
              onClick={handleAddModbusRegister}
              style={{ marginTop: "10px" }}
            >
              + 添加到 M表
            </button>
          </section>

          {/* Batch operations */}
          <section className="panel" style={{ background: "rgba(255, 255, 255, 0.02)" }}>
            <h3>{t("modbus.batchOps", { defaultValue: "批量配置管理" })}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "8px" }}>
              <button className="btn-secondary" onClick={handleExportJSON} disabled={registers.length === 0} style={{ padding: "8px" }}>
                导出 JSON
              </button>
              <button className="btn-secondary" onClick={() => fileInputRef.current?.click()} style={{ padding: "8px" }}>
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
            >
              清空 M表
            </button>
          </section>
        </>
      ) : (
        <section className="panel">
          <h3>CAN总线监测</h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "12px", margin: "10px 0" }}>
            当前功能规划中，后续将加入此监测表。
          </p>
          <div style={{ opacity: 0.3, pointerEvents: "none" }}>
            <div className="form-group">
              <label>波特率</label>
              <select defaultValue="250k"><option>250k</option></select>
            </div>
            <button className="btn-connect" style={{ marginTop: "10px" }}>打开CAN通道</button>
          </div>
        </section>
      )}
    </aside>
  );
}
