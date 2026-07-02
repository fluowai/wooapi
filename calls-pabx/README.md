# Wozapi Calls / PABX

Modulo separado para planejar e desenvolver chamadas WhatsApp e PABX sem alterar o servidor principal da Wozapi.

## Componentes

- `wozapi-calls-gateway`: API segura entre painel/Wozapi e os motores de chamada.
- `wacalls`: servico baseado em WaCalls, usado como tronco WhatsApp.
- `asterisk`: PABX real para ramais, filas, URA, transferencia e gravacao.
- `postgres` ou banco atual: persistencia de linhas, agentes, filas, historico e eventos.

## Regra De Ouro

O servidor principal atual continua intacto. Este modulo deve rodar em portas, containers e banco/namespace proprios ate estar validado.

## Etapas

1. Prova tecnica WaCalls isolada.
2. Gateway Wozapi Calls com auth e tenant isolation.
3. Mini PABX no gateway.
4. Asterisk isolado.
5. Ponte de midia Asterisk <-> WaCalls.
6. Produto whitelabel.

## Arquivos

- `docker-compose.calls.yml`: stack separada proposta.
- `api-contract.md`: endpoints do gateway.
- `schema.sql`: tabelas iniciais do modulo.
- `THIRD_PARTY_NOTICES.md`: base para licencas open source.

## Portas Sugeridas

- `3100`: Wozapi Calls Gateway.
- `3180`: WaCalls interno, nao publicar em producao.
- `8088`: Asterisk HTTP/ARI interno.
- `5060`: SIP UDP/TCP, somente quando necessario.
- `8089`: WebRTC/TLS, somente quando necessario.

## Status

Planejamento inicial. Nenhum servico atual da Wozapi depende destes arquivos.
