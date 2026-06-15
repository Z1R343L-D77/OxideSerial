[简体中文](README.md) | **English**

<!-- markdownlint-disable -->

<div align="center">

<img src="./src-tauri/icons/icon.png" width="120" alt="OxideSerial Icon">

# OxideSerial

Industrial-Grade Serial Port Debugger<br>
Built with Tauri 2 + Rust + React

[Report Issue](https://github.com/Z1R343L-D77/OxideSerial/issues) · [Changelog](https://github.com/Z1R343L-D77/OxideSerial/releases) <br>
[Quick Start](#quick-start) · [Features](#features) · [Build Guide](#build-from-source)

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

## Why OxideSerial

Most serial debugging tools either have outdated UIs, rely on Java/Python runtimes, or lack the performance for smooth real-time waveform display. OxideSerial is built on Rust — no runtime dependencies, instant startup, zero-latency data processing, and a modern dark/light themed interface.

## Features

### Serial Connection

- Automatic COM port detection, baud rates from 1,200 to 4,000,000
- Configurable data bits (5–8), stop bits (1–2), parity (none/odd/even)
- Rust background thread for continuous reading via event-driven push

### Terminal Display

- ASCII / HEX dual-mode send & receive
- Line ending options (none / LF / CR / CRLF / LFCR)
- Send history (last 20 entries, click to recall)
- Auto-send with configurable interval
- Clear input button

### Waveform Display

- High-performance real-time line chart powered by uPlot
- Multi-channel auto-detection (CSV format `v1,v2,v3\n`)
- Scroll-wheel zoom (centered on cursor, scroll up to zoom in)
- Left-click drag to pan
- Auto mode follows latest data
- Pause / Resume / Clear
- CSV data export
- Configurable status bar: Δt sample interval, buffer limit, auto-align points
- Cursor position displays time and channel values in real time

### Modbus RTU

- Function codes 01–06
- Automatic frame construction with CRC16 checksum
- Response parsing (including exception detection)

### Settings Panel

- Theme toggle (Light / Dark / Follow System)
- Language toggle (简体中文 / English / 繁體中文)
- Default view mode (Terminal / Waveform / Split)
- Close to tray, auto-start on boot
- Version display

## Data Format

Send CSV-formatted data from your device for automatic waveform display:

```
1.23,4.56,7.89
2.34,5.67,8.90
```

Each value maps to a channel with auto-assigned colors. Any number of channels is supported.

## Use Cases

- Industrial controller debugging & data monitoring
- Sensor data acquisition & visualization
- Modbus RTU device communication testing
- Embedded development serial debugging
- Real-time waveform analysis

## Quick Start

### Download

Head to the [Release page](https://github.com/Z1R343L-D77/OxideSerial/releases/latest) to download.

| File | Description |
| ---- | ----------- |
| `OxideSerial_x64-setup.exe` | NSIS Installer |
| `OxideSerial_x64.msi` | MSI Installer |
| `OxideSerial_x64.exe` | Portable (no installation needed) |

### Build from Source

#### Requirements

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/) >= 1.77
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Windows)
- Windows SDK

#### Build Steps

```bash
# Clone the repository
git clone https://github.com/Z1R343L-D77/OxideSerial.git
cd OxideSerial

# Install frontend dependencies
npm install

# Run in development mode
npx tauri dev

# Build production release
npx tauri build
```

### Testing

The project includes a Python test script for simulating serial data:

```bash
# Install pyserial
pip install pyserial

# List available ports
python test_serial.py

# Send sine wave simulation (test waveform display)
python test_serial.py COM11 sine

# Send Modbus simulation
python test_serial.py COM11 modbus
```

> Requires [com0com](https://sourceforge.net/projects/com0com/) virtual serial port driver

## Tech Stack

| Layer | Technology | Purpose |
| ----- | ---------- | ------- |
| Frontend | React 19 + TypeScript | UI components & interaction |
| Charts | uPlot | High-performance real-time rendering |
| Backend | Rust + serialport | Serial communication & data processing |
| Framework | Tauri 2 | Cross-platform desktop app framework |
| Protocol | Modbus RTU | Industrial communication protocol |
| i18n | i18next | Chinese / English / Traditional Chinese |

## Project Structure

```
OxideSerial/
├── src/                          # Frontend source
│   ├── App.tsx                   # Main interface
│   ├── App.css                   # Styles (light/dark theme variables)
│   ├── components/
│   │   ├── WaveformPanel.tsx     # Waveform display component
│   │   └── SettingsPanel.tsx     # Settings panel
│   ├── locales/                  # i18n translations
│   │   ├── zh-CN/translation.json
│   │   ├── en-US/translation.json
│   │   └── zh-HK/translation.json
│   ├── types/config.ts           # Config type definitions
│   └── utils/theme.ts            # Theme switching utility
├── src-tauri/                    # Rust backend
│   ├── src/lib.rs                # Serial logic, Modbus protocol, event push
│   └── Cargo.toml                # Rust dependencies
├── test_serial.py                # Test script
└── README.md
```

## Contributing

Issues and Pull Requests are welcome!

## License

[MIT License](LICENSE)
