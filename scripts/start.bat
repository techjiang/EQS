@echo off
chcp 65001 >nul
title EQS 问卷系统
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 22 或更高版本：https://nodejs.org
  pause
  exit /b 1
)

if not exist data mkdir data
echo 正在启动 EQS ... 数据目录：%cd%\data
start "" http://localhost:8080
node server\index.js
pause
