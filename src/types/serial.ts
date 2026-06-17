// 备注：前后端共享的数据类型定义

export interface SerialConfig {
  port_name: string;
  baud_rate: number;
  data_bits: number;
  stop_bits: number;
  parity: string;
  protocol: string;
}

export interface SerialStatus {
  connected: boolean;
  port_name: string;
  baud_rate: number;
}

export interface TerminalData {
  direction: string;
  hex: string;
  ascii: string;
  timestamp: string;
}

export interface DataFrame {
  timestamp: number;
  values: number[];
  raw: string;
}

export interface LogEntry {
  id: number;
  timestamp: string;
  direction: string;
  data: string;
  hex: string;
  ascii: string;
}
