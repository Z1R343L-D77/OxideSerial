import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ModbusRegister, ByteOrderOption } from "../types/modbus";

interface ModbusMonitorProps {
  registers: ModbusRegister[];
  setRegisters: React.Dispatch<React.SetStateAction<ModbusRegister[]>>;
  isPolling: boolean;
  pollInterval: number;
  byteOrder: ByteOrderOption;
  connected: boolean;
  onAddTextLog: (direction: string, text: string) => void;
}

export function ModbusMonitor({
  registers,
  setRegisters,
  isPolling,
  pollInterval,
  byteOrder,
  connected,
  onAddTextLog,
}: ModbusMonitorProps) {
  // References for polling queue state machine
  const registersRef = useRef<ModbusRegister[]>(registers);
  const activeIndex = useRef(0);
  const rxBuffer = useRef<number[]>([]);
  const currentRegister = useRef<ModbusRegister | null>(null);
  const isWriteInProgress = useRef(false);

  // Timers
  const timeoutTimer = useRef<number | null>(null);
  const pollDelayTimer = useRef<number | null>(null);

  // UI States
  const [editingField, setEditingField] = useState<{ id: string; field: "name" | "address" } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [writeModalReg, setWriteModalReg] = useState<ModbusRegister | null>(null);
  const [writeValue, setWriteValue] = useState("");

  // Sync registers to ref so polling loop always has fresh data
  useEffect(() => {
    registersRef.current = registers;
  }, [registers]);

  // Keep a clean function to update register state
  const updateRegisterStatus = (id: string, status: ModbusRegister["status"], value?: string) => {
    setRegisters((prev) =>
      prev.map((r) => {
        if (r.id === id) {
          const next: ModbusRegister = { ...r, status };
          if (value !== undefined) {
            next.value = value;
            if (status === "success") {
              next.lastUpdated = new Date().toLocaleTimeString();
            }
          }
          return next;
        }
        return r;
      })
    );
  };

  // 1. Sequential Polling Loop
  const pollNext = async () => {
    // Stop if conditions are not met
    if (!connected || !isPolling || isWriteInProgress.current) {
      return;
    }

    const enabled = registersRef.current.filter((r) => r.enabled);
    if (enabled.length === 0) {
      // No registers enabled, check again in pollInterval
      pollDelayTimer.current = window.setTimeout(pollNext, pollInterval);
      return;
    }

    if (activeIndex.current >= enabled.length) {
      activeIndex.current = 0;
    }

    const reg = enabled[activeIndex.current];
    currentRegister.current = reg;
    rxBuffer.current = [];

    // Set UI to polling
    updateRegisterStatus(reg.id, "polling");

    try {
      // Build read RTU frame
      const frame = await invoke<number[]>("build_modbus_rtu", {
        slaveId: reg.slaveId,
        functionCode: reg.functionCode,
        registerAddr: reg.address,
        registerCount: reg.count,
      });

      // Start response timeout timer (300ms)
      timeoutTimer.current = window.setTimeout(() => {
        handleTimeout(reg);
      }, 300);

      // Send the data
      await invoke("send_data", { data: frame });
    } catch (e: any) {
      updateRegisterStatus(reg.id, "error", `发送错误: ${e}`);
      onAddTextLog("ERROR", `Modbus 扫频发送错误: ${e}`);
      triggerNextPoll();
    }
  };

  const handleTimeout = (reg: ModbusRegister) => {
    if (currentRegister.current?.id === reg.id) {
      updateRegisterStatus(reg.id, "error", "超时无应答");
      onAddTextLog("ERROR", `Modbus 超时: 从站 ${reg.slaveId}, 地址 ${reg.address}`);
      currentRegister.current = null;
      triggerNextPoll();
    }
  };

  const triggerNextPoll = () => {
    if (timeoutTimer.current) {
      clearTimeout(timeoutTimer.current);
      timeoutTimer.current = null;
    }
    activeIndex.current += 1;
    pollDelayTimer.current = window.setTimeout(pollNext, 50); // 50ms safety inter-frame delay
  };

  // Start/Stop Polling hook
  useEffect(() => {
    if (isPolling && connected) {
      activeIndex.current = 0;
      void pollNext();
    } else {
      if (pollDelayTimer.current) {
        clearTimeout(pollDelayTimer.current);
        pollDelayTimer.current = null;
      }
      if (timeoutTimer.current) {
        clearTimeout(timeoutTimer.current);
        timeoutTimer.current = null;
      }
      currentRegister.current = null;
    }

    return () => {
      if (pollDelayTimer.current) clearTimeout(pollDelayTimer.current);
      if (timeoutTimer.current) clearTimeout(timeoutTimer.current);
    };
  }, [isPolling, connected]);

  // 2. Listen to Serial RX Events
  useEffect(() => {
    const unlistenPromise = listen<any>("serial-data", (event) => {
      const d = event.payload;
      if (d.direction !== "RX") return;
      if (!isPolling || !currentRegister.current || isWriteInProgress.current) return;

      // Convert hex strings back to raw bytes
      const bytes = d.hex
        .split(" ")
        .filter(Boolean)
        .map((h: string) => parseInt(h, 16));

      rxBuffer.current = [...rxBuffer.current, ...bytes];
      void processRxBuffer();
    });

    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, [isPolling, byteOrder]);

  const processRxBuffer = async () => {
    const reg = currentRegister.current;
    if (!reg) return;

    const buf = rxBuffer.current;
    if (buf.length < 3) return; // Need at least header + byte count to do anything

    const slaveId = buf[0];
    const fc = buf[1];

    // Check Exception response
    const isException = (fc & 0x80) !== 0;

    if (isException) {
      if (buf.length >= 5) {
        const frame = buf.slice(0, 5);
        rxBuffer.current = buf.slice(5);

        // Cancel timeout
        if (timeoutTimer.current) {
          clearTimeout(timeoutTimer.current);
          timeoutTimer.current = null;
        }
        currentRegister.current = null;

        try {
          const res = await invoke<any>("parse_modbus_rtu", { data: frame });
          const errCode = res.exception_code ? `0x${res.exception_code.toString(16).toUpperCase()}` : "未知";
          updateRegisterStatus(reg.id, "error", `异常码: ${errCode}`);
          onAddTextLog("ERROR", `从站 ${slaveId} 返回异常: ${errCode} (地址 ${reg.address})`);
        } catch {
          updateRegisterStatus(reg.id, "error", "解析错误");
        }
        triggerNextPoll();
      }
      return;
    }

    // Normal response length: 5 + N bytes where N = buf[2]
    const byteCount = buf[2];
    const expectedLen = 5 + byteCount;

    if (buf.length >= expectedLen) {
      const frame = buf.slice(0, expectedLen);
      rxBuffer.current = buf.slice(expectedLen);

      // Cancel timeout
      if (timeoutTimer.current) {
        clearTimeout(timeoutTimer.current);
        timeoutTimer.current = null;
      }
      currentRegister.current = null;

      try {
        const res = await invoke<any>("parse_modbus_rtu", { data: frame });
        if (res.crc_valid) {
          const valStr = decodeModbusData(res.data, reg.dataType, byteOrder);
          updateRegisterStatus(reg.id, "success", valStr);
        } else {
          updateRegisterStatus(reg.id, "error", "CRC 校验失败");
          onAddTextLog("ERROR", `从站 ${slaveId} 数据帧 CRC 校验失败`);
        }
      } catch (e: any) {
        updateRegisterStatus(reg.id, "error", `解析失败: ${e}`);
      }
      triggerNextPoll();
    }
  };

  // 3. Write register executor
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
      alert("输入格式错误，请检查对应数据类型！");
      return;
    }

    // Pause polling thread
    isWriteInProgress.current = true;
    if (timeoutTimer.current) clearTimeout(timeoutTimer.current);
    if (pollDelayTimer.current) clearTimeout(pollDelayTimer.current);
    currentRegister.current = null;

    try {
      const frame = await invoke<number[]>("build_modbus_write_rtu", {
        slaveId: reg.slaveId,
        functionCode: writeFC,
        registerAddr: reg.address,
        data: dataBytes,
      });

      let resolved = false;

      // Register temporary listener to wait for write confirmation echo (timeout 600ms)
      const writePromise = new Promise<boolean>((resolve, reject) => {
        const unlistenPromise = listen<any>("serial-data", (event) => {
          if (resolved) return;
          const d = event.payload;
          if (d.direction !== "RX") return;

          const bytes = d.hex
            .split(" ")
            .filter(Boolean)
            .map((h: string) => parseInt(h, 16));

          // Echo response validation (usually matches slave ID and function code)
          if (bytes.length >= 8 && bytes[0] === reg.slaveId && bytes[1] === writeFC) {
            resolved = true;
            resolve(true);
          }
        });

        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            void unlistenPromise.then((fn) => fn());
            reject(new Error("写入超时无响应"));
          }
        }, 600);
      });

      // Send write frame
      await invoke("send_data", { data: frame });
      await writePromise;

      // Update locally
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

      onAddTextLog("INFO", `Modbus 成功写入从站 ${reg.slaveId} 地址 ${reg.address} = ${writeValue}`);
      setWriteModalReg(null);
    } catch (err: any) {
      alert(`写入失败: ${err.message || err}`);
      onAddTextLog("ERROR", `Modbus 写入从站 ${reg.slaveId} 地址 ${reg.address} 失败: ${err.message || err}`);
    } finally {
      isWriteInProgress.current = false;
      // Resume polling
      if (isPolling) {
        pollDelayTimer.current = window.setTimeout(pollNext, pollInterval);
      }
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
          <span>Modbus M表监测</span>
          {isPolling && <span className="polling-pulse-dot" title="活跃轮询中" />}
        </div>
        <div className="modbus-monitor-status-box">
          连接状态:{" "}
          <span className={`status-text ${connected ? "online" : "offline"}`}>
            {connected ? "已连接" : "断开"}
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
                          title={isPolling ? "" : "双击修改名称"}
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
                          title={isPolling ? "" : "双击修改地址"}
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
                          {isPollingRow ? "轮询中" : isSuccessRow ? "正常" : isErrorRow ? "异常" : "等待"}
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
                          title={connected ? "写入此寄存器" : "串口未连接，无法写入"}
                        >
                          写入
                        </button>
                        <button
                          className="btn-row-action delete"
                          onClick={() => handleDeleteRegister(r.id)}
                          disabled={isPolling}
                          title="删除监控行"
                        >
                          删除
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
              <h3>写入寄存器数值</h3>
              <button className="write-modal-close" onClick={() => setWriteModalReg(null)}>
                &times;
              </button>
            </div>
            <form onSubmit={handleWriteSubmit}>
              <div className="write-modal-info">
                <div>
                  <label>别名:</label> <span>{writeModalReg.name}</span>
                </div>
                <div>
                  <label>从站 ID:</label> <span>{writeModalReg.slaveId}</span>
                </div>
                <div>
                  <label>地址:</label> <span>{writeModalReg.address}</span>
                </div>
                <div>
                  <label>数据类型:</label>{" "}
                  <span className={`datatype-badge type-${writeModalReg.dataType}`}>
                    {writeModalReg.dataType}
                  </span>
                </div>
              </div>

              <div className="form-group" style={{ marginTop: "15px" }}>
                <label>写入数值:</label>
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
                    placeholder={`请输入要写入的 ${writeModalReg.dataType} 数值`}
                    value={writeValue}
                    onChange={(e) => setWriteValue(e.target.value)}
                    className="modal-text-input"
                  />
                )}
              </div>

              <div className="write-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setWriteModalReg(null)}>
                  取消
                </button>
                <button type="submit" className="btn-connect">
                  写入发送
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper: Decode binary Modbus registers
function decodeModbusData(data: number[], dataType: string, byteOrder: ByteOrderOption): string {
  if (dataType === "bool") {
    return (data[0] & 0x01) !== 0 ? "ON" : "OFF";
  }

  if (dataType === "int16" || dataType === "uint16") {
    if (data.length < 2) return "-";
    const u8 = new Uint8Array(data);
    const view = new DataView(u8.buffer);
    return dataType === "int16"
      ? view.getInt16(0, false).toString()
      : view.getUint16(0, false).toString();
  }

  // 32-bit types
  if (data.length < 4) return "-";
  const swapped = new Uint8Array(4);
  switch (byteOrder) {
    case "ABCD":
      swapped[0] = data[0];
      swapped[1] = data[1];
      swapped[2] = data[2];
      swapped[3] = data[3];
      break;
    case "CDAB":
      swapped[0] = data[2];
      swapped[1] = data[3];
      swapped[2] = data[0];
      swapped[3] = data[1];
      break;
    case "BADC":
      swapped[0] = data[1];
      swapped[1] = data[0];
      swapped[2] = data[3];
      swapped[3] = data[2];
      break;
    case "DCBA":
      swapped[0] = data[3];
      swapped[1] = data[2];
      swapped[2] = data[1];
      swapped[3] = data[0];
      break;
  }

  const view = new DataView(swapped.buffer);
  switch (dataType) {
    case "int32":
      return view.getInt32(0, false).toString();
    case "uint32":
      return view.getUint32(0, false).toString();
    case "float32":
      const val = view.getFloat32(0, false);
      if (isNaN(val)) return "NaN";
      if (!isFinite(val)) return "Infinity";
      return val.toFixed(4).replace(/\.?0+$/, "");
    default:
      return "-";
  }
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
