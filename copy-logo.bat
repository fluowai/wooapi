:: Script para copiar o logo Wozapi para a pasta public
:: Execute este arquivo clicando duas vezes nele

@echo off
if not exist "public" mkdir "public"

:: Tente copiar qualquer arquivo de logo que exista
if exist "wozapi-logo.png" (
    copy /y "wozapi-logo.png" "public\wozapi-logo.png"
    echo Logo copiado com sucesso!
) else (
    echo ATENCAO: Coloque o arquivo wozapi-logo.png na pasta raiz do projeto e execute este script novamente.
)

pause
