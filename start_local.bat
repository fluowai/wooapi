@echo off
for /f "usebackq tokens=1,* delims==" %%A in ("C:\Users\paulo\Vibecoding\Ferramentas\wasenderbr-1\.env") do (
  if /I "%%A"=="BRIDGE_TOKEN" if "%BRIDGE_TOKEN%"=="" set BRIDGE_TOKEN=%%B
)
if "%BRIDGE_TOKEN%"=="" set BRIDGE_TOKEN=troque-este-token-interno
set BRIDGE_URL=http://127.0.0.1:3001
set PORT=3000
set APP_URL=http://127.0.0.1:3000
set NODE_URL=http://127.0.0.1:3000
set DATABASE_URL=
set NODE_ENV=development
set BRIDGE_DB_PATH=wooapi_bridge.db
set BRIDGE_MEDIA_CACHE_DIR=media-cache
set DB_TYPE=sqlite
set QUEUE_DRIVER=database
set REDIS_HOST=
set REDIS_PORT=
set REDIS_URL=
set EXPERIMENTAL_INTERACTIVE_MESSAGES=false
if "%WOZAPI_ENGINE%"=="" set WOZAPI_ENGINE=whatsmeow
if "%WOZAPI_V2_BRIDGE_URL%"=="" set WOZAPI_V2_BRIDGE_URL=http://127.0.0.1:3003
if "%WOZAPI_V2_BRIDGE_PORT%"=="" set WOZAPI_V2_BRIDGE_PORT=3003
if "%WOZAPI_V2_UPSTREAM_URL%"=="" set WOZAPI_V2_UPSTREAM_URL=http://127.0.0.1:3004
if "%BRIDGE_DEVICE_NAME%"=="" set BRIDGE_DEVICE_NAME=Wozapi
if "%WOZAPI_V2_DEVICE_NAME%"=="" set WOZAPI_V2_DEVICE_NAME=Wozapi2
if "%WOZAPI_V2_BROWSER_NAME%"=="" set WOZAPI_V2_BROWSER_NAME=Wozapi2
echo Iniciando Wozapi Core 1.0...
if not exist "C:\Users\paulo\Vibecoding\Ferramentas\wasenderbr-1\go-bridge\bridge.exe" (
  echo [ERRO] Bridge nao encontrado. Execute build-bridge.bat antes de iniciar.
  pause
  exit /b 1
)
start /B /D "C:\Users\paulo\Vibecoding\Ferramentas\wasenderbr-1\go-bridge" bridge.exe
echo Iniciando Wozapi Core 2.0...
start /B /D "C:\Users\paulo\Vibecoding\Ferramentas\wasenderbr-1" npm run engine:v2
for /L %%i in (1,1,20) do (
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/health' -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch { exit 1 }"
  if not errorlevel 1 goto bridge_ready
  timeout /t 1 /nobreak >nul
)
echo [ERRO] Bridge nao respondeu em http://127.0.0.1:3001/health.
echo        Feche processos antigos do bridge e tente novamente.
pause
exit /b 1

:bridge_ready
echo Iniciando servidor Node...
start /B /D "C:\Users\paulo\Vibecoding\Ferramentas\wasenderbr-1" npm run start
echo.
echo ============================================================
echo  WooAPI rodando em http://localhost:3000
echo  Wozapi 1.0 rodando em http://localhost:3001
echo  Wozapi 2.0 rodando em %WOZAPI_V2_BRIDGE_URL%
echo  Modo: SQLite local (sem Redis, sem Postgres)
echo ============================================================
