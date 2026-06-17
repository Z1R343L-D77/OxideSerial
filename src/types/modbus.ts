export interface ModbusRegister {
  id: string;          // Unique identifier
  name: string;        // Editable alias/label (e.g., "Motor Speed")
  slaveId: number;     // 1 - 247
  functionCode: number;// Read FC: 1 (Coils), 2 (Inputs), 3 (Holding), 4 (Input Registers)
  address: number;     // 0 - 65535
  count: number;       // Number of registers (1 for 16-bit, 2 for 32-bit, etc.)
  dataType: "bool" | "int16" | "uint16" | "int32" | "uint32" | "float32";
  value: string;       // Dynamic string value or error message
  status: "idle" | "polling" | "success" | "error";
  lastUpdated?: string;// Timestamp of last successful read
  enabled: boolean;    // Toggle polling for this register
}

export type ByteOrderOption = "ABCD" | "CDAB" | "BADC" | "DCBA";
