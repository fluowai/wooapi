@echo off
if "%BRIDGE_TOKEN%"=="" set BRIDGE_TOKEN=troque-este-token-interno
set BRIDGE_URL=http://127.0.0.1:3001
set PORT=3000
set APP_URL=http://127.0.0.1:3000
set NODE_URL=http://127.0.0.1:3000
set BRIDGE_MEDIA_CACHE_DIR=media-cache
set REDIS_HOST=127.0.0.1
set REDIS_PORT=6379
set REDIS_URL=redis://127.0.0.1:6379
set QUEUE_DRIVER=database
set EXPERIMENTAL_INTERACTIVE_MESSAGES=false
start /B /D "C:\Users\paulo\Vibecoding\Ferramentas\wasenderbr-1\go-bridge" bridge.exe
timeout /t 3 /nobreak >nul
start /B /D "C:\Users\paulo\Vibecoding\Ferramentas\wasenderbr-1" npm run start
echo Bridge e servidor iniciados. Para filas/campanhas locais, mantenha Redis em 127.0.0.1:6379.
