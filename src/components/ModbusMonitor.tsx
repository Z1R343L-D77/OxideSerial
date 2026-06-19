import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import type { ModbusRegister, ByteOrderOption } from "../types/modbus";

interface ModbusMonitorProps {
  registers: ModbusRegister[];
  setRegisters: React.Dispatch<React.SetStateAction<ModbusRegister[]>>;
  isPolling: boolean;
  byteOrder: ByteOrderOption;
  connected: boolean;
  onAddTextLog: (direction: string, text: string) => void;
}

export function ModbusMonitor({
  registers,
  setRegisters,
  isPolling,
  byteOrder,
  connected,
  onAddTextLog,
}: ModbusMonitorProps) {
  const { t } = useTranslation();
  // UI States
  const [editingField, setEditingField] = useState<{ id: string; field: "name" | "address" } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [writeModalReg, setWriteModalReg] = useState<ModbusRegister | null>(null);
  const [writeValue, setWriteValue] = useState("");

  // 监听后端推送的轮询数据结果
  useEffect(() => {
    interface ModbusRegisterResult {
      id: string;
      value: string;
      status: string;
      last_updated: string;
    }

    const unlistenPromise = listen<ModbusRegisterResult[]>("modbus-poll-result", (event) => {
      const results = event.payload;
      setRegisters((prev) =>
        prev.map((r) => {
          const matched = results.find((res) => res.id === r.id);
          if (matched) {
            return {
              ...r,
              value: matched.value,
              status: matched.status as ModbusRegister["status"],
              lastUpdated: matched.last_updated,
            };
          }
          return r;
        })
      );
    });

    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, [setRegisters]);

  // 写入寄存器执行器
  const handleWriteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!writeModalReg || !connected) return;

    const reg = writeModalReg;
    let writeFC = 6;
    if (reg.dataType === "bool") {
      writeFC = 5;
    } else if (reg.dataType === "int32" || reg.dataType === "uint32" || reg.dataType === "float32") {
      writeFC = 16;
    }

    const dataBytes = prepareWriteData(writeValue, reg.dataType, byteOrder);
    if (!dataBytes) {
      alert(t("modbus.inputError", { defaultValue: "输入格式错误，请检查对应数据类型！" }));
      return;
    }

    try {
      // 直接调用后端写入指令并等待响应（底层自动进行互斥锁保护）
      await invoke("write_modbus_register", {
        slaveId: reg.slaveId,
        functionCode: writeFC,
        registerAddr: reg.address,
        data: dataBytes,
      });

      // 本地同步更新显示值
      const friendlyVal =
        reg.dataType === "bool"
          ? writeValue.toLowerCase() === "true" || writeValue === "1" || writeValue.toLowerCase() === "on"
            ? "ON"
            : "OFF"
          : writeValue;

      setRegisters((prev) =>
        prev.map((r) =>
          r.id === reg.id
            ? {
                ...r,
                value: friendlyVal,
                status: "success",
                lastUpdated: new Date().toLocaleTimeString(),
              }
            : r
        )
      );

      onAddTextLog("INFO", `Modbus ${t("modbus.writeSuccess", { defaultValue: "成功写入" })} ${t("modbus.slaveId", { defaultValue: "从站" })} ${reg.slaveId} ${t("modbus.regAddr", { defaultValue: "地址" })} ${reg.address} = ${writeValue}`);
      setWriteModalReg(null);
    } catch (err: any) {
      alert(`${t("modbus.writeFail", { defaultValue: "写入失败" })}: ${err}`);
      onAddTextLog("ERROR", `Modbus ${t("modbus.writeFail", { defaultValue: "写入失败" })} ${t("modbus.slaveId", { defaultValue: "从站" })} ${reg.slaveId} ${t("modbus.regAddr", { defaultValue: "地址" })} ${reg.address}: ${err}`);
    }
  };

  // Inline row edits
  const startEditField = (id: string, field: "name" | "address", val: string | number) => {
    setEditingField({ id, field });
    setEditValue(String(val));
  };

  const submitEditField = () => {
    if (!editingField) return;
    const { id, field } = editingField;

    setRegisters((prev) =>
      prev.map((r) => {
        if (r.id === id) {
          if (field === "name") {
            return { ...r, name: editValue.trim() || r.name };
          } else if (field === "address") {
            const num = Number(editValue);
            return { ...r, address: isNaN(num) ? r.address : Math.max(0, num) };
          }
        }
        return r;
      })
    );
    setEditingField(null);
  };

  const handleCheckboxChange = (id: string, enabled: boolean) => {
    setRegisters((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
  };

  const handleDeleteRegister = (id: string) => {
    setRegisters((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="modbus-monitor-card">
      <div className="modbus-monitor-header">
        <div className="modbus-monitor-title">
          <span>{t("modbus.monitorTitle", { defaultValue: "Modbus M表监测" })}</span>
          {isPolling && <span className="polling-pulse-dot" title={t("modbus.activePolling", { defaultValue: "活跃轮询中" })} />}
        </div>
        <div className="modbus-monitor-status-box">
          {t("modbus.connStatus", { defaultValue: "连接状态" })}:{" "}
          <span className={`status-text ${connected ? "online" : "offline"}`}>
            {connected ? t("modbus.connected", { defaultValue: "已连接" }) : t("modbus.disconnected", { defaultValue: "断开" })}
          </span>
        </div>
      </div>

      <div className="modbus-monitor-body">
        {registers.length === 0 ? (
          <div className="empty-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 14.5a8 8 0 1 1 16 0M2 18h20" />
              <path d="M12 4v2" />
            </svg>
            <p>监测表为空。请在左侧侧边栏中配置并“添加寄存器”到本表中。</p>
            <span style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "6px" }}>
              💡 小提示：您可以双击行内的【别名】和【地址】来直接在线修改。
            </span>
          </div>
        ) : (
          <table className="modbus-monitor-table">
            <thead>
              <tr>
                <th style={{ width: "40px", textAlign: "center" }}>启用</th>
                <th>别名 (双击编辑)</th>
                <th style={{ width: "80px" }}>从站 ID</th>
                <th style={{ width: "80px" }}>功能码</th>
                <th style={{ width: "90px" }}>地址 (双击)</th>
                <th style={{ width: "100px" }}>类型</th>
                <th style={{ textAlign: "right", minWidth: "120px" }}>当前监测值</th>
                <th style={{ width: "110px", textAlign: "center" }}>状态</th>
                <th style={{ width: "110px", textAlign: "center" }}>更新时间</th>
                <th style={{ width: "100px", textAlign: "center" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {registers.map((r) => {
                const isSelected = editingField?.id === r.id;
                const isPollingRow = r.status === "polling";
                const isSuccessRow = r.status === "success";
                const isErrorRow = r.status === "error";

                return (
                  <tr key={r.id} className={`${isPollingRow ? "row-polling" : ""} ${!r.enabled ? "row-disabled" : ""}`}>
                    {/* Enable toggle */}
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={(e) => handleCheckboxChange(r.id, e.target.checked)}
                        disabled={isPolling}
                      />
                    </td>

                    {/* Alias Name */}
                    <td>
                      {isSelected && editingField.field === "name" ? (
                        <input
                          type="text"
                          className="table-inline-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={submitEditField}
                          onKeyDown={(e) => e.key === "Enter" && submitEditField()}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="editable-cell-text"
                          onDoubleClick={() => !isPolling && startEditField(r.id, "name", r.name)}
                          title={isPolling ? "" : t("modbus.dblClickName", { defaultValue: "双击修改名称" })}
                        >
                          {r.name}
                        </span>
                      )}
                    </td>

                    {/* Slave ID */}
                    <td>{r.slaveId}</td>

                    {/* Function Code */}
                    <td>{`0${r.functionCode}`}</td>

                    {/* Address */}
                    <td>
                      {isSelected && editingField.field === "address" ? (
                        <input
                          type="number"
                          className="table-inline-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={submitEditField}
                          onKeyDown={(e) => e.key === "Enter" && submitEditField()}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="editable-cell-text monospace"
                          onDoubleClick={() => !isPolling && startEditField(r.id, "address", r.address)}
                          title={isPolling ? "" : t("modbus.dblClickAddr", { defaultValue: "双击修改地址" })}
                        >
                          {r.address}
                        </span>
                      )}
                    </td>

                    {/* Datatype badge */}
                    <td>
                      <span className={`datatype-badge type-${r.dataType}`}>{r.dataType}</span>
                    </td>

                    {/* Value cell */}
                    <td className="value-cell monospace">
                      <span
                        className={`value-display ${isSuccessRow ? "success" : isErrorRow ? "error" : "idle"}`}
                      >
                        {r.value}
                      </span>
                    </td>

                    {/* Status Indicator */}
                    <td style={{ textAlign: "center" }}>
                      <div className="status-indicator-cell">
                        <span
                          className={`status-circle ${
                            isPollingRow ? "polling" : isSuccessRow ? "success" : isErrorRow ? "error" : "idle"
                          }`}
                        />
                        <span className="status-label">
                          {isPollingRow ? t("modbus.statusPolling", { defaultValue: "轮询中" }) : isSuccessRow ? t("modbus.statusNormal", { defaultValue: "正常" }) : isErrorRow ? t("modbus.statusError", { defaultValue: "异常" }) : t("modbus.statusWaiting", { defaultValue: "等待" })}
                        </span>
                      </div>
                    </td>

                    {/* Last Updated */}
                    <td style={{ textAlign: "center", fontSize: "11px" }} className="monospace text-muted">
                      {r.lastUpdated || "-"}
                    </td>

                    {/* Row Actions */}
                    <td style={{ textAlign: "center" }}>
                      <div className="row-actions-group">
                        <button
                          className="btn-row-action write"
                          onClick={() => {
                            setWriteModalReg(r);
                            setWriteValue(r.dataType === "bool" ? "ON" : "");
                          }}
                          disabled={!connected}
                          title={connected ? t("modbus.writeRegister", { defaultValue: "写入此寄存器" }) : t("modbus.writeDisabled", { defaultValue: "串口未连接，无法写入" })}
                        >
                          {t("modbus.write", { defaultValue: "写入" })}
                        </button>
                        <button
                          className="btn-row-action delete"
                          onClick={() => handleDeleteRegister(r.id)}
                          disabled={isPolling}
                          title={t("modbus.deleteRow", { defaultValue: "删除监控行" })}
                        >
                          {t("modbus.delete", { defaultValue: "删除" })}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Write value Modal */}
      {writeModalReg && (
        <div className="write-modal-backdrop">
          <div className="write-modal-content">
            <div className="write-modal-header">
              <h3>{t("modbus.writeModalTitle", { defaultValue: "写入寄存器数值" })}</h3>
              <button className="write-modal-close" onClick={() => setWriteModalReg(null)}>
                &times;
              </button>
            </div>
            <form onSubmit={handleWriteSubmit}>
              <div className="write-modal-info">
                <div>
                  <label>{t("modbus.modalAlias", { defaultValue: "别名" })}:</label> <span>{writeModalReg.name}</span>
                </div>
                <div>
                  <label>{t("modbus.slaveId", { defaultValue: "从站 ID" })}:</label> <span>{writeModalReg.slaveId}</span>
                </div>
                <div>
                  <label>{t("modbus.regAddr", { defaultValue: "地址" })}:</label> <span>{writeModalReg.address}</span>
                </div>
                <div>
                  <label>{t("modbus.dataType", { defaultValue: "数据类型" })}:</label>{" "}
                  <span className={`datatype-badge type-${writeModalReg.dataType}`}>
                    {writeModalReg.dataType}
                  </span>
                </div>
              </div>

              <div className="form-group" style={{ marginTop: "15px" }}>
                <label>{t("modbus.writeValue", { defaultValue: "写入数值" })}:</label>
                {writeModalReg.dataType === "bool" ? (
                  <select
                    value={writeValue}
                    onChange={(e) => setWriteValue(e.target.value)}
                    className="modal-select-input"
                  >
                    <option value="ON">ON (开 / 0xFF00)</option>
                    <option value="OFF">OFF (关 / 0x0000)</option>
                  </select>
                ) : (
                  <input
                    type="text"
                    required
                    placeholder={`${t("modbus.inputPlaceholder", { defaultValue: "请输入要写入的" })} ${writeModalReg.dataType} ${t("modbus.inputValue", { defaultValue: "数值" })}`}
                    value={writeValue}
                    onChange={(e) => setWriteValue(e.target.value)}
                    className="modal-text-input"
                  />
                )}
              </div>

              <div className="write-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setWriteModalReg(null)}>
                  {t("modbus.cancel", { defaultValue: "取消" })}
                </button>
                <button type="submit" className="btn-connect">
                  {t("modbus.writeSend", { defaultValue: "写入发送" })}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}



// Helper: Convert user input to bytes array based on DataType & ByteOrder
function prepareWriteData(valueStr: string, dataType: string, byteOrder: ByteOrderOption): number[] | null {
  if (dataType === "bool") {
    const isTrue = valueStr.toLowerCase() === "true" || valueStr === "1" || valueStr.toLowerCase() === "on";
    return isTrue ? [0xff, 0x00] : [0x00, 0x00];
  }

  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);

  if (dataType === "int16" || dataType === "uint16") {
    const val = parseInt(valueStr, 10);
    if (isNaN(val)) return null;
    const u8 = new Uint8Array(2);
    const view16 = new DataView(u8.buffer);
    if (dataType === "int16") {
      view16.setInt16(0, val, false);
    } else {
      view16.setUint16(0, val, false);
    }
    return Array.from(u8);
  }

  // 32-bit
  if (dataType === "int32") {
    const val = parseInt(valueStr, 10);
    if (isNaN(val)) return null;
    view.setInt32(0, val, false);
  } else if (dataType === "uint32") {
    const val = parseInt(valueStr, 10);
    if (isNaN(val)) return null;
    view.setUint32(0, val, false);
  } else if (dataType === "float32") {
    const val = parseFloat(valueStr);
    if (isNaN(val)) return null;
    view.setFloat32(0, val, false);
  } else {
    return null;
  }

  const bytes = Array.from(new Uint8Array(buf));
  const swapped = new Uint8Array(4);
  switch (byteOrder) {
    case "ABCD":
      swapped[0] = bytes[0];
      swapped[1] = bytes[1];
      swapped[2] = bytes[2];
      swapped[3] = bytes[3];
      break;
    case "CDAB":
      swapped[0] = bytes[2];
      swapped[1] = bytes[3];
      swapped[2] = bytes[0];
      swapped[3] = bytes[1];
      break;
    case "BADC":
      swapped[0] = bytes[1];
      swapped[1] = bytes[0];
      swapped[2] = bytes[3];
      swapped[3] = bytes[2];
      break;
    case "DCBA":
      swapped[0] = bytes[3];
      swapped[1] = bytes[2];
      swapped[2] = bytes[1];
      swapped[3] = bytes[0];
      break;
  }
  return Array.from(swapped);
}
