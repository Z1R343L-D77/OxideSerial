// 备注：前后端共享的数据类型定义

export interface SerialConfig {
  mode: string; // "serial" | "udp" | "tcp_client" | "tcp_server"
  port_name: string;
  baud_rate: number;
  data_bits: number;
  stop_bits: number;
  parity: string;
  protocol: string;

  // UDP
  udp_remote_ip: string;
  udp_remote_port: number;
  udp_local_port: number;

  // TCP Client
  tcp_client_ip: string;
  tcp_client_port: number;
  tcp_client_handshake: string;

  // TCP Server
  tcp_server_port: number;
}

export interface SerialStatus {
  connected: boolean;
  port_name: string;
  baud_rate: number;
  mode: string;
  reconnecting?: boolean;
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
  gbk?: string;
}
