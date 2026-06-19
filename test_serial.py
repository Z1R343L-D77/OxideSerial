"""
串口与网络数据调试器测试脚本
支持模拟串口、UDP、TCP客户端、TCP服务端发送数据，并异步显示收到的数据。

使用方法：
1. 串口模式（默认）：
   python test_serial.py COM11 sine
   python test_serial.py serial COM11 modbus

2. UDP 模式（往调试器绑定的 UDP 本地端口 1347 发送，绑定本地端口 1346 接收调试器发来的数据）：
   python test_serial.py udp 1347 1346 sine
   python test_serial.py udp 1347 1346 modbus

3. TCP 客户端模式（向调试器启动的 TCP 服务端 1347 发起连接）：
   python test_serial.py tcp_client 1347 sine
   python test_serial.py tcp_client 1347 modbus

4. TCP 服务端模式（作为服务端在 1346 端口监听，等待调试器的 TCP 客户端连接）：
   python test_serial.py tcp_server 1346 sine
   python test_serial.py tcp_server 1346 modbus
"""

import sys
import math
import time
import socket
import threading
import serial
import serial.tools.list_ports


class Connection:
    def __init__(self, mode, target, extra=None):
        self.mode = mode
        self.target = target
        self.extra = extra
        self.ser = None
        self.sock = None
        self.conn = None  # TCP Server 接受的客户端连接
        self.addr = None
        self.remote_addr = None

    def open(self):
        if self.mode == "serial":
            self.ser = serial.Serial(
                port=self.target,
                baudrate=115200,
                bytesize=8,
                parity="N",
                stopbits=1,
                timeout=0.1,
            )
            print(f"已打开串口: {self.target} @ 115200")
        elif self.mode == "udp":
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            local_port = int(self.extra) if self.extra else 1346
            self.sock.bind(("127.0.0.1", local_port))
            remote_port = int(self.target) if self.target else 1347
            self.remote_addr = ("127.0.0.1", remote_port)
            print(f"UDP 已绑定至本地 127.0.0.1:{local_port}，目标远程地址为 127.0.0.1:{remote_port}")
        elif self.mode == "tcp_server":
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            port = int(self.target) if self.target else 1346
            self.sock.bind(("127.0.0.1", port))
            self.sock.listen(1)
            print(f"TCP 服务端已在 127.0.0.1:{port} 启动监听，等待客户端连接...")
            self.conn, self.addr = self.sock.accept()
            print(f"连接成功！客户端地址: {self.addr}")
        elif self.mode == "tcp_client":
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            port = int(self.target) if self.target else 1347
            print(f"正在连接到 TCP 服务端 127.0.0.1:{port}...")
            self.sock.connect(("127.0.0.1", port))
            print("连接成功！")

    def write(self, data):
        if self.mode == "serial":
            self.ser.write(data)
        elif self.mode == "udp":
            self.sock.sendto(data, self.remote_addr)
        elif self.mode == "tcp_server":
            if self.conn:
                self.conn.sendall(data)
        elif self.mode == "tcp_client":
            self.sock.sendall(data)

    def close(self):
        if self.ser:
            self.ser.close()
        if self.conn:
            self.conn.close()
        if self.sock:
            self.sock.close()
        print("连接已关闭")


def start_reader_thread(conn):
    """启动后台读取线程，输出从调试器接收到的数据"""
    def read_loop():
        try:
            while True:
                if conn.mode == "serial":
                    if conn.ser.in_waiting > 0:
                        data = conn.ser.read(conn.ser.in_waiting)
                        print_received(data, conn.target)
                elif conn.mode == "udp":
                    data, addr = conn.sock.recvfrom(4096)
                    print_received(data, f"UDP:{addr[0]}:{addr[1]}")
                elif conn.mode == "tcp_server":
                    if conn.conn:
                        data = conn.conn.recv(4096)
                        if not data:
                            print("\n[INFO] 客户端已断开 TCP 连接")
                            break
                        print_received(data, f"TCP Client:{conn.addr[0]}:{conn.addr[1]}")
                elif conn.mode == "tcp_client":
                    data = conn.sock.recv(4096)
                    if not data:
                        print("\n[INFO] TCP 服务端已断开连接")
                        break
                    print_received(data, "TCP Server")
                time.sleep(0.01)
        except Exception:
            pass

    def print_received(data, source):
        hex_str = data.hex(" ").upper()
        try:
            ascii_str = data.decode("utf-8")
        except UnicodeDecodeError:
            try:
                ascii_str = data.decode("gbk")
            except Exception:
                ascii_str = "".join(chr(b) if 32 <= b < 127 else "." for b in data)
        
        print(f"\n<<< 收到数据 [{source}]:")
        print(f"    HEX:   {hex_str}")
        print(f"    ASCII: {ascii_str.strip()}")

    t = threading.Thread(target=read_loop, daemon=True)
    t.start()


def list_ports():
    ports = serial.tools.list_ports.comports()
    if not ports:
        print("没有检测到物理/虚拟串口设备")
        return []
    print("可用串口:")
    for p in ports:
        print(f"  {p.device} - {p.description}")
    return ports


def send_sine_wave(conn, duration=120, interval=0.05):
    """发送正弦波模拟数据（3通道）"""
    print(f"\n开始发送正弦波模拟数据，持续 {duration} 秒...")
    print("数据格式: 通道1(sin),通道2(cos),通道3(三角波)\\n")
    print("按 Ctrl+C 停止\n")

    start = time.time()
    count = 0

    try:
        while time.time() - start < duration:
            t = time.time() - start

            ch1 = math.sin(t * 2) * 100
            ch2 = math.cos(t * 3) * 80
            ch3 = (t % 2) * 100 - 50

            line = f"{ch1:.2f},{ch2:.2f},{ch3:.2f}\n"
            conn.write(line.encode("utf-8"))

            count += 1
            if count % 20 == 0:
                elapsed = time.time() - start
                print(f"  [{elapsed:.1f}s] 已发送 {count} 帧 | "
                      f"CH1={ch1:.1f} CH2={ch2:.1f} CH3={ch3:.1f}")

            time.sleep(interval)

    except KeyboardInterrupt:
        print("\n用户中断发送")

    print(f"\n发送完成，共 {count} 帧")


def send_raw_hex(conn, duration=60):
    """发送原始 HEX 数据（模拟 Modbus 响应）"""
    print(f"\n开始发送 Modbus 模拟响应，持续 {duration} 秒...")
    print("按 Ctrl+C 停止\n")
    start = time.time()
    count = 0

    try:
        while time.time() - start < duration:
            slave_id = 0x01
            func_code = 0x03
            byte_count = 0x04
            reg1 = int(100 + 50 * math.sin(time.time() * 2))
            reg2 = int(200 + 80 * math.cos(time.time() * 1.5))

            data = bytes([
                slave_id, func_code, byte_count,
                (reg1 >> 8) & 0xFF, reg1 & 0xFF,
                (reg2 >> 8) & 0xFF, reg2 & 0xFF,
            ])

            # 计算 CRC16
            crc = 0xFFFF
            for b in data:
                crc ^= b
                for _ in range(8):
                    if crc & 0x0001:
                        crc = (crc >> 1) ^ 0xA001
                    else:
                        crc >>= 1

            frame = data + bytes([crc & 0xFF, (crc >> 8) & 0xFF])
            conn.write(frame)

            count += 1
            if count % 10 == 0:
                print(f"  [{time.time() - start:.1f}s] 已发送 {count} 帧 | "
                      f"温度(Reg1)={reg1} 湿度(Reg2)={reg2}")

            time.sleep(1)

    except KeyboardInterrupt:
        print("\n用户中断发送")

    print(f"\n发送完成，共 {count} 帧")


def print_usage():
    print("=" * 60)
    print("串口与网络数据调试器测试脚本")
    print("=" * 60)
    print("\n参数选项:")
    print("  serial <port_name> [mode]    - 串口模拟 (如 COM11)")
    print("  udp [remote_port] [local_port] [mode] - UDP 模拟 (默认 1347 1346)")
    print("  tcp_client [port] [mode]     - TCP 客户端模拟 (默认 1347)")
    print("  tcp_server [port] [mode]     - TCP 服务端模拟 (默认 1346)")
    print("\n模式 [mode] 可选值:")
    print("  sine                         - 发送多通道正弦波数据 (波形图测试)")
    print("  modbus                       - 发送 Modbus RTU 响应包 (HEX/M表测试)")
    print("\n或者向下兼容原用法:")
    print(f"  python {sys.argv[0]} <串口名> [mode] (例如: python {sys.argv[0]} COM11)")
    print("=" * 60)
    list_ports()


def main():
    if len(sys.argv) < 2:
        print_usage()
        return

    first_arg = sys.argv[1]
    
    # 模式解析
    if first_arg == "udp":
        mode = "udp"
        target = sys.argv[2] if len(sys.argv) > 2 else "1347"
        extra = sys.argv[3] if len(sys.argv) > 3 else "1346"
        data_mode = sys.argv[4] if len(sys.argv) > 4 else "sine"
    elif first_arg == "tcp_server":
        mode = "tcp_server"
        target = sys.argv[2] if len(sys.argv) > 2 else "1346"
        extra = None
        data_mode = sys.argv[3] if len(sys.argv) > 3 else "sine"
    elif first_arg == "tcp_client":
        mode = "tcp_client"
        target = sys.argv[2] if len(sys.argv) > 2 else "1347"
        extra = None
        data_mode = sys.argv[3] if len(sys.argv) > 3 else "sine"
    elif first_arg == "serial":
        mode = "serial"
        target = sys.argv[2] if len(sys.argv) > 2 else ""
        extra = None
        data_mode = sys.argv[3] if len(sys.argv) > 3 else "sine"
        if not target:
            print("错误: 必须指定串口名称")
            list_ports()
            return
    else:
        # 向下兼容: 第一个参数直接是串口名 (如 COM11)
        mode = "serial"
        target = first_arg
        extra = None
        data_mode = sys.argv[2] if len(sys.argv) > 2 else "sine"

    conn = Connection(mode, target, extra)
    
    try:
        conn.open()
        start_reader_thread(conn)
        
        if data_mode == "modbus":
            send_raw_hex(conn)
        else:
            send_sine_wave(conn)
            
    except Exception as e:
        print(f"\n[ERROR] 运行出错: {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
