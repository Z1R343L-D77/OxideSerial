"""
串口调试器测试脚本
使用 com0com 虚拟串口对发送模拟数据

使用方法：
1. 安装 com0com: https://sourceforge.net/projects/com0com/
2. 安装后会创建虚拟串口对，如 COM10 和 COM11
3. 在串口调试器中打开 COM10
4. 运行此脚本: python test_serial.py COM11
"""

import sys
import math
import time
import serial
import serial.tools.list_ports


def list_ports():
    """列出所有可用串口"""
    ports = serial.tools.list_ports.comports()
    if not ports:
        print("没有检测到串口设备")
        print("请先安装 com0com 虚拟串口驱动:")
        print("  https://sourceforge.net/projects/com0com/")
        return []
    print("可用串口:")
    for p in ports:
        print(f"  {p.device} - {p.description}")
    return ports


def send_sine_wave(ser, duration=60, interval=0.05):
    """发送正弦波模拟数据（3通道）"""
    print(f"\n开始发送模拟数据，持续 {duration} 秒...")
    print("数据格式: 时间戳,通道1(sin),通道2(cos),通道3(三角波)")
    print("按 Ctrl+C 停止\n")

    start = time.time()
    count = 0

    try:
        while time.time() - start < duration:
            t = time.time() - start

            # 备注：生成3通道模拟数据
            ch1 = math.sin(t * 2) * 100           # 正弦波
            ch2 = math.cos(t * 3) * 80             # 余弦波
            ch3 = (t % 2) * 100 - 50               # 三角波

            line = f"{ch1:.2f},{ch2:.2f},{ch3:.2f}\n"
            ser.write(line.encode("utf-8"))

            count += 1
            if count % 20 == 0:
                elapsed = time.time() - start
                print(f"  [{elapsed:.1f}s] 已发送 {count} 帧 | "
                      f"CH1={ch1:.1f} CH2={ch2:.1f} CH3={ch3:.1f}")

            time.sleep(interval)

    except KeyboardInterrupt:
        print("\n用户中断")

    print(f"\n发送完成，共 {count} 帧")


def send_raw_hex(ser, duration=30):
    """发送原始 HEX 数据（模拟工业设备响应）"""
    print(f"\n开始发送 Modbus 模拟响应，持续 {duration} 秒...")
    start = time.time()
    count = 0

    try:
        while time.time() - start < duration:
            # 备注：模拟 Modbus RTU 响应（从站1，功能码03，2个寄存器）
            slave_id = 0x01
            func_code = 0x03
            byte_count = 0x04
            reg1 = int(100 + 50 * math.sin(time.time() * 2))  # 模拟温度
            reg2 = int(200 + 80 * math.cos(time.time() * 1.5))  # 模拟湿度

            data = bytes([
                slave_id, func_code, byte_count,
                (reg1 >> 8) & 0xFF, reg1 & 0xFF,
                (reg2 >> 8) & 0xFF, reg2 & 0xFF,
            ])

            # 备注：计算 CRC16
            crc = 0xFFFF
            for b in data:
                crc ^= b
                for _ in range(8):
                    if crc & 0x0001:
                        crc = (crc >> 1) ^ 0xA001
                    else:
                        crc >>= 1

            frame = data + bytes([crc & 0xFF, (crc >> 8) & 0xFF])
            ser.write(frame)

            count += 1
            if count % 10 == 0:
                print(f"  [{time.time() - start:.1f}s] 已发送 {count} 帧 | "
                      f"温度={reg1} 湿度={reg2}")

            time.sleep(1)

    except KeyboardInterrupt:
        print("\n用户中断")

    print(f"\n发送完成，共 {count} 帧")


def main():
    if len(sys.argv) < 2:
        print("=" * 50)
        print("串口调试器测试脚本")
        print("=" * 50)
        print()
        ports = list_ports()
        if ports:
            print(f"\n用法: python {sys.argv[0]} <串口名>")
            print(f"示例: python {sys.argv[0]} COM11")
            print()
            print("模式:")
            print("  sine  - 发送正弦波数据（默认，用于测试波形显示）")
            print("  modbus - 发送 Modbus RTU 模拟响应")
            print()
            print(f"示例: python {sys.argv[0]} COM11 sine")
            print(f"示例: python {sys.argv[0]} COM11 modbus")
        return

    port_name = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "sine"

    try:
        ser = serial.Serial(
            port=port_name,
            baudrate=115200,
            bytesize=8,
            parity="N",
            stopbits=1,
            timeout=1,
        )
        print(f"已打开串口: {port_name} @ 115200")
    except serial.SerialException as e:
        print(f"打开串口失败: {e}")
        print("请确认串口名称正确，且未被其他程序占用")
        return

    try:
        if mode == "modbus":
            send_raw_hex(ser)
        else:
            send_sine_wave(ser)
    finally:
        ser.close()
        print("串口已关闭")


if __name__ == "__main__":
    main()
