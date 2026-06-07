@echo off
echo [WooAPI] Compilando Go Bridge...
cd /d "%~dp0go-bridge"

go build -o wooapi_bridge.exe .
if %ERRORLEVEL% NEQ 0 (
    echo [ERRO] Falha na compilacao. Verifique se o Go esta instalado e no PATH.
    echo        Download: https://go.dev/dl/
    pause
    exit /b 1
)

echo [OK] wooapi_bridge.exe compilado com sucesso!
echo.
echo Para reiniciar o sistema, feche o bridge atual e execute novamente:
echo   go-bridge\wooapi_bridge.exe
pause
