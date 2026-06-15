@echo off
REM OxideSerial 开发环境配置
REM 设置 Windows SDK 路径
set SDK=D:\002_sdk\Microsoft VS studio\win11Kit
set VER=10.0.28000.0

REM 设置 MSVC 库路径
set LIB=%SDK%\Lib\%VER%\um\x64;%SDK%\Lib\%VER%\ucrt\x64;C:\BuildTools\VC\Tools\MSVC\14.44.35207\lib\x64
set INCLUDE=%SDK%\Include\%VER%\um;%SDK%\Include\%VER%\ucrt;%SDK%\Include\%VER%\shared;C:\BuildTools\VC\Tools\MSVC\14.44.35207\include

REM 设置 PATH（MSVC 工具链优先）
set PATH=C:\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64;%USERPROFILE%\.cargo\bin;%PATH%

REM 设置代理
set HTTPS_PROXY=http://127.0.0.1:7897
set HTTP_PROXY=http://127.0.0.1:7897

echo 开发环境配置完成
echo SDK: %SDK%
echo MSVC: C:\BuildTools\VC\Tools\MSVC\14.44.35207

REM 启动 VS Code
code .
