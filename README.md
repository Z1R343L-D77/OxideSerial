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

市面上的串口调试工具，要么界面陈旧、依赖 Java 或 Python 运行时，要么性能不足、无法流畅显示实时波形。OxideSerial 基于 Rust 构建，无运行时依赖，启动速度快，数据处理零延迟，同时提供现代化的暗色/亮色主题界面。

## 功能特点

### 数据连接

- **串口模式**：COM 口自动检测（显示设备友好名称），波特率 1200 ~ 4000000，可配置数据位/停止位/校验位
- **UDP 模式**：支持远程 IP/端口配置，本地端口绑定
- **TCP Client**：支持目标 IP/端口、自定义握手数据包
- **TCP Server**：支持多客户端连接、客户端选择、客户端管理
- 连接断开自动检测与重连提示
- RX/TX 字节计数器实时显示

### 终端显示

- ASCII / HEX 双模式收发，HEX 输入自动格式化
- HEX 切换影响全部历史记录（实时切换显示）
- 发送模式切换自动转换输入（ASCII↔HEX 自动去/加空格）
- 行尾追加（无 / LF / CR / CRLF / LFCR）
- 快捷发送面板（10 条可配置，支持注释/延迟/HEX 模式）
- 发送历史记录（最近 20 条，点击回填）
- 自动发送（可调间隔）
- 时间戳跟随语言设置
- 终端日志导出（.txt 文件）
- 终端搜索（关键字高亮匹配）
- 自动滚动锁定（上翻时显示浮动徽章）
- UTF-8 / GBK 编码切换

### 波形显示

- 基于 uPlot 的高性能实时折线图
- 多通道数据自动识别（CSV 格式 `v1,v2,v3\n`）
- 波形侧边栏（通道实时数值 + 显隐切换）
- 波形底部滚动条（拖拽快速导航）
- 信息栏（总点数/可视点数、时间分度值）
- 滚轮缩放（以鼠标位置为中心，上滚放大，下滚缩小）
- 左键拖拽平移
- Auto 模式自动跟随最新数据
- 暂停/恢复/清空
- CSV 数据导出
- 状态栏可调参数：△t 采样间隔（含 Hz 显示）、缓冲区上限、Auto 点数对齐
- 光标位置实时显示时间和通道值

### Modbus RTU

- 功能码 01-06 支持
- 自动帧构建与 CRC16 校验
- 响应解析（含异常检测）
- Modbus 监测表（M 表）：寄存器别名、数据类型、实时值、状态指示
- 后端自动轮询（可调间隔）
- 寄存器写入（功能码 05/06/16）
- 批量配置管理

### 设置面板

- 主题切换（浅色 / 深色 / 跟随系统）
- 语言切换（简体中文 / English / 繁體中文）
- 默认视图模式（终端 / 波形 / 分屏）
- 关闭到托盘（可配置）
- 开机自启
- 窗口状态记忆（大小、位置、最大化）
- 自定义窗口控制栏（最小化/最大化/关闭/窗口置顶）

### 安全与稳定性

- 串口断开自动检测与恢复
- HEX 发送输入校验（非法字符报错）
- 线程安全的串口读写（Mutex 安全锁）
- React ErrorBoundary 防止白屏
- Content Security Policy

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
- 网络设备调试（UDP/TCP）
- 实时波形分析

## 快速开始

### 下载安装

请前往 [Release 页](https://github.com/Z1R343L-D77/OxideSerial/releases/latest) 下载

| 文件 | 说明 |
| ---- | ---- |
| `OxideSerial_x64-setup.exe` | NSIS 安装包 |
| `OxideSerial_x64.msi` | MSI 安装包 |
| `OxideSerial_x64.exe` | 便携版（无需安装） |

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
| 后端     | Rust + serialport     | 串口/UDP/TCP 通信与数据处理  |
| 框架     | Tauri 2               | 跨平台桌面应用框架           |
| 协议     | Modbus RTU            | 工业通信协议支持             |
| 国际化   | i18next               | 中/英/繁体三语言支持         |

## 项目结构

```
OxideSerial/
├── src/                          # 前端源码
│   ├── App.tsx                   # 主布局
│   ├── App.css                   # 样式（暖色主题变量 + 动效系统）
│   ├── components/
│   │   ├── Header.tsx            # 顶部工具栏
│   │   ├── Sidebar.tsx           # 连接配置 + Modbus 面板
│   │   ├── TerminalPanel.tsx     # 终端显示 + 发送区
│   │   ├── WaveformPanel.tsx     # 波形显示组件
│   │   ├── ModbusMonitor.tsx     # Modbus M 表监测
│   │   ├── SettingsPanel.tsx     # 设置面板
│   │   └── ErrorBoundary.tsx     # 错误边界
│   ├── hooks/
│   │   ├── useSerial.ts          # 连接管理 Hook
│   │   └── useTerminalLogs.ts    # 终端日志 Hook
│   ├── types/
│   │   ├── config.ts             # 配置类型 + APP_VERSION
│   │   ├── serial.ts             # 连接数据类型
│   │   └── modbus.ts             # Modbus 类型定义
│   ├── locales/                  # 国际化翻译
│   ├── utils/theme.ts            # 主题切换工具
│   └── main.tsx                  # 入口（含 ErrorBoundary）
├── src-tauri/                    # Rust 后端
│   ├── src/lib.rs                # 连接逻辑、Modbus 协议、事件推送
│   └── Cargo.toml                # Rust 依赖
├── test_serial.py                # 测试脚本
└── README.md
```

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

[MIT License](LICENSE)
