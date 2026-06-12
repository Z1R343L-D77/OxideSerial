**简体中文** | [English](README_en-US.md)

<!-- markdownlint-disable -->

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="OxideSerial 图标">

# OxideSerial

工业级串口调试器<br>
基于 Tauri 2 + Rust + React 构建

[反馈问题](https://github.com/Z1R343L-D77/OxideSerial/issues) · [更新日志](https://github.com/Z1R343L-D77/OxideSerial/releases) <br>
[快速开始](#快速开始) · [功能特点](#功能特点) · [构建指南](#从源码构建)

[![Version](https://img.shields.io/github/v/release/Z1R343L-D77/OxideSerial)](https://github.com/Z1R343L-D77/OxideSerial/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Stars](https://img.shields.io/github/stars/Z1R343L-D77/OxideSerial?color=ffcb47&labelColor=black)</br>
![React 19](https://img.shields.io/badge/React-19-blue?logo=react)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-%2324C8D8?logo=tauri)
![Rust Edition 2021](https://img.shields.io/badge/Rust-2021-%23000000?logo=rust)<br>
![uPlot](https://img.shields.io/badge/uPlot-Realtime--Chart-green)

</div>

<!-- markdownlint-restore -->

---

## 为什么选择 OxideSerial

市面上的串口调试工具，要么界面陈旧、依赖 Java 或 Python 运行时，要么性能不足、无法流畅显示实时波形。OxideSerial 基于 Rust 构建，无运行时依赖，启动速度快，数据处理零延迟，同时提供现代化的暗色主题界面。

## 功能特点

- **串口连接** — 支持 COM 口自动检测，波特率最高 921600，可配置数据位、停止位、校验位

- **终端显示** — ASCII / HEX 双模式收发，实时数据日志

- **波形显示** — 基于 uPlot 的高性能实时折线图，支持多通道数据自动识别

- **Modbus RTU** — 内置 Modbus 协议支持，功能码 01-06，自动帧构建与 CRC16 校验

- **三种视图** — 终端模式 / 波形模式 / 分屏模式，按需切换

- **后台读取** — Rust 线程持续读取串口数据，通过事件机制推送到前端，零延迟

- **自动发送** — 可配置间隔的定时发送功能

## 数据格式

设备发送以下格式的 CSV 数据即可自动显示波形：

```
1.23,4.56,7.89
2.34,5.67,8.90
```

每个数值对应一个通道，自动分配颜色，支持任意通道数。

## 应用场景

- 工业控制器调试与数据监控
- 传感器数据采集与可视化
- Modbus RTU 设备通信测试
- 嵌入式开发串口调试
- 实时波形分析

## 快速开始

### 下载安装

请前往 [Release 页](https://github.com/Z1R343L-D77/OxideSerial/releases/latest) 下载

| 系统    | 架构 | 类型     | 文件名                                  |
| ------- | ---- | -------- | --------------------------------------- |
| Windows | x64  | Setup    | `OxideSerial_x64-setup.exe`            |
| Windows | x64  | Portable | `OxideSerial_x64-portable.exe`         |

### 从源码构建

#### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/) >= 1.77
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Windows)
- Windows SDK

#### 构建步骤

```bash
# 克隆仓库
git clone https://github.com/Z1R343L-D77/OxideSerial.git
cd OxideSerial

# 安装前端依赖
npm install

# 开发模式运行
npx tauri dev

# 构建生产版本
npx tauri build
```

### 测试

项目附带 Python 测试脚本，可用于模拟串口数据：

```bash
# 安装 pyserial
pip install pyserial

# 查看可用串口
python test_serial.py

# 发送正弦波模拟数据（测试波形显示）
python test_serial.py COM11 sine

# 发送 Modbus 模拟数据
python test_serial.py COM11 modbus
```

> 需要先安装 [com0com](https://sourceforge.net/projects/com0com/) 虚拟串口驱动

## 技术栈

| 层级     | 技术                  | 说明                         |
| -------- | --------------------- | ---------------------------- |
| 前端     | React 19 + TypeScript | UI 组件与交互逻辑            |
| 图表     | uPlot                 | 高性能实时折线图渲染         |
| 后端     | Rust + serialport     | 串口通信与数据处理           |
| 框架     | Tauri 2               | 跨平台桌面应用框架           |
| 协议     | Modbus RTU            | 工业通信协议支持             |

## 项目结构

```
OxideSerial/
├── src/                        # 前端源码
│   ├── App.tsx                 # 主界面
│   ├── App.css                 # 样式
│   └── components/
│       └── WaveformPanel.tsx   # 波形显示组件
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   └── lib.rs              # 串口逻辑、Modbus 协议
│   └── Cargo.toml              # Rust 依赖
├── test_serial.py              # 测试脚本
└── README.md
```

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

[MIT License](LICENSE)
