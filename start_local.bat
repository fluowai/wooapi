@echo off
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
echo Iniciando WooAPI Core (bridge)...
start /B /D "C:\Users\paulo\Vibecoding\Ferramentas\wasenderbr-1\go-bridge" bridge_new.exe
timeout /t 3 /nobreak >nul
echo Iniciando servidor Node...
start /B /D "C:\Users\paulo\Vibecoding\Ferramentas\wasenderbr-1" npm run start
echo.
echo ============================================================
echo  WooAPI rodando em http://localhost:3000
echo  Bridge rodando em http://localhost:3001
echo  Modo: SQLite local (sem Redis, sem Postgres)
echo ============================================================
