@echo off
setlocal

docker compose version >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop is required. Install it, start it, then run this file again.
  exit /b 1
)

docker compose run --rm --build video-agent --data /workspace/data %*
exit /b %errorlevel%
