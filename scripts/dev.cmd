@echo off
REM Kapibala local dev launcher (Windows thin shell, double-clickable).
REM
REM This file only locates node and forwards all args to scripts/dev.mjs.
REM All logic lives in dev.mjs so the two shells never drift apart.
REM
REM NOTE: keep this file pure ASCII. cmd.exe reads .cmd files using the
REM OEM codepage (GBK on zh-CN Windows) BEFORE chcp takes effect, so any
REM non-ASCII byte here corrupts parsing and breaks the script.
REM
REM Usage:
REM   dev.cmd                 build + verify + start REPL
REM   dev.cmd --no-verify     skip typecheck/test/lint
REM   dev.cmd -p "hello"      one-shot question

REM Switch to UTF-8 so Node output (Chinese) renders correctly.
chcp 65001 >nul 2>&1

setlocal

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node not found. Please install Node.js 18 or later.
  exit /b 1
)

REM %~dp0 already ends with a backslash, so concatenate directly.
node "%~dp0dev.mjs" %*

set EXIT_CODE=%ERRORLEVEL%
endlocal & exit /b %EXIT_CODE%
