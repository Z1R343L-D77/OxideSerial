import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { SerialConfig, SerialStatus } from "../types/serial";

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
}

export function Sidebar({ ports, serialConfig, status, onSerialConfigChange, onRefreshPorts, onTogglePort, onError }: SidebarProps) {
  const { t } = useTranslation();

  // 备注：Modbus
  const [modbusSlaveId, setModbusSlaveId] = useState(1);
  const [modbusFunction, setModbusFunction] = useState(3);
  const [modbusRegister, setModbusRegister] = useState(0);
  const [modbusCount, setModbusCount] = useState(1);

  const handleModbusSend = useCallback(async () => {
    if (!status.connected) return;
    try {
      const frame = await invoke<number[]>("build_modbus_rtu", {
        slaveId: modbusSlaveId,
        functionCode: modbusFunction,
        registerAddr: modbusRegister,
        registerCount: modbusCount,
      });
      await invoke("send_data", { data: frame });
    } catch (e) {
      onError(`${e}`);
    }
  }, [status.connected, modbusSlaveId, modbusFunction, modbusRegister, modbusCount, onError]);

  return (
    <aside className="sidebar">
      <section className="panel">
        <h3>{t("serial.title", { defaultValue: "串口配置" })}</h3>
        <div className="form-group">
          <label>{t("serial.port", { defaultValue: "串口" })}</label>
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

      <section className="panel">
        <h3>{t("modbus.title", { defaultValue: "Modbus RTU" })}</h3>
        <div className="form-row">
          <div className="form-group"><label>{t("modbus.slaveId", { defaultValue: "从站 ID" })}</label>
            <input type="number" min={1} max={247} value={modbusSlaveId} onChange={(e) => setModbusSlaveId(Number(e.target.value))} />
          </div>
          <div className="form-group"><label>{t("modbus.functionCode", { defaultValue: "功能码" })}</label>
            <select value={modbusFunction} onChange={(e) => setModbusFunction(Number(e.target.value))}>
              <option value={1}>01</option>
              <option value={2}>02</option>
              <option value={3}>03</option>
              <option value={4}>04</option>
              <option value={5}>05</option>
              <option value={6}>06</option>
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>{t("modbus.startAddr", { defaultValue: "起始地址" })}</label>
            <input type="number" min={0} max={65535} value={modbusRegister} onChange={(e) => setModbusRegister(Number(e.target.value))} />
          </div>
          <div className="form-group"><label>{t("modbus.count", { defaultValue: "数量" })}</label>
            <input type="number" min={1} max={125} value={modbusCount} onChange={(e) => setModbusCount(Number(e.target.value))} />
          </div>
        </div>
        <button className="btn-modbus" onClick={handleModbusSend} disabled={!status.connected}>{t("modbus.send", { defaultValue: "发送 Modbus" })}</button>
      </section>
    </aside>
  );
}
