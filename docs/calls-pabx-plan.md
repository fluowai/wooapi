# Wozapi Calls / PABX - Plano Separado

Este plano descreve como adicionar ligacoes WhatsApp e recursos de PABX sem alterar o servidor principal atual. A regra de arquitetura e simples: o Wozapi existente continua sendo o produto de mensagens, painel, billing e multi-tenant; o modulo de chamadas nasce separado e conversa com ele por API interna.

## Objetivo

Criar um modulo whitelabel de chamadas com tres camadas:

- **Wozapi Calls Gateway**: API propria, autenticacao, tenants, permissoes, eventos, logs e integracao com o painel.
- **WaCalls Service**: motor tecnico de chamadas WhatsApp 1:1, isolado em rede interna.
- **Asterisk PBX**: PABX real para ramais, filas, URA, transferencia, gravacao e troncos SIP quando a etapa exigir.

## Principio de Isolamento

Nao alterar:

- `server.ts`
- workers atuais
- bridge atual
- WAHA/Wozapi v2 atual
- docker-compose principal, exceto em uma etapa futura e controlada

Criar separado:

- `calls-pabx/`
- `calls-pabx/docker-compose.calls.yml`
- API gateway proprio
- banco/tabelas proprias
- documentacao e contrato independente

## Arquitetura Alvo

```text
Browser / Painel Wozapi
  |
  | JWT Wozapi ou token interno
  v
Wozapi Calls Gateway
  |-- valida tenant, plano, agente, permissao
  |-- grava historico/eventos
  |-- emite webhooks call.*
  |
  +--> WaCalls Service
  |      |-- sessoes WhatsApp de voz
  |      |-- chamada 1:1
  |      |-- WebRTC/audio browser
  |
  +--> Asterisk PBX
         |-- ramais SIP/WebRTC
         |-- filas
         |-- URA
         |-- transferencia
         |-- gravacao
```

## Decisao Sobre Asterisk

O Asterisk deve entrar como PABX, nao como motor WhatsApp. Ele e bom para:

- ramais
- filas
- URA
- transferencia
- gravacao
- CDR
- musica de espera
- SIP/WebRTC
- troncos externos

A WaCalls deve entrar como tronco WhatsApp especializado. A ponte completa de midia Asterisk <-> WaCalls precisa P&D, porque WhatsApp nao e SIP.

## Fases

### Fase 0 - Preparacao

Entregaveis:

- Plano de arquitetura.
- Contrato de API proposto.
- Schema inicial.
- Stack Docker separada.
- Checklist de seguranca/licenca.

Criterio de aceite:

- Nenhuma alteracao no servidor atual.
- Modulo planejado como servico isolado.

### Fase 1 - Prova Tecnica WaCalls Isolada

Objetivo:

Validar se chamadas WhatsApp funcionam de ponta a ponta em ambiente controlado.

Entregaveis:

- Fork interno/espelho da WaCalls.
- Build do binario Go.
- Servico `wacalls` rodando em porta interna.
- Volume persistente para `wacalls.db`.
- Teste manual de:
  - criar sessao
  - ler QR
  - receber chamada
  - iniciar chamada
  - encerrar chamada
  - consultar historico

Riscos:

- API WaCalls nao tem autenticacao.
- Banco contem credenciais WhatsApp.
- Precisa rede interna, nunca porta publica.

### Fase 2 - Wozapi Calls Gateway

Objetivo:

Criar uma API segura entre Wozapi/painel e WaCalls.

Entregaveis:

- Servico separado `wozapi-calls-gateway`.
- Autenticacao por token interno ou JWT validado.
- Mapeamento `account_id` -> linhas de chamada.
- Proxy controlado para WaCalls.
- Logs e eventos `call.*`.
- Rate limit por tenant/agente/linha.
- WebSocket ou SSE para eventos em tempo real.

Endpoints principais:

- `GET /health`
- `GET /v1/call-lines`
- `POST /v1/call-lines`
- `POST /v1/call-lines/:id/pair`
- `GET /v1/calls`
- `POST /v1/calls`
- `POST /v1/calls/:id/accept`
- `POST /v1/calls/:id/reject`
- `DELETE /v1/calls/:id`
- `GET /v1/events`

### Fase 3 - Mini PABX No Gateway

Objetivo:

Entregar valor comercial antes da ponte complexa com Asterisk.

Entregaveis:

- Agentes.
- Status de agente: online, ocupado, ausente, offline.
- Filas simples: comercial, suporte, financeiro.
- Distribuicao round-robin.
- Horario de atendimento.
- Historico por lead/contato.
- Tela de chamadas no painel futuro.
- Webhooks:
  - `call.incoming`
  - `call.ringing`
  - `call.answered`
  - `call.rejected`
  - `call.missed`
  - `call.ended`
  - `call.failed`

Criterio de aceite:

- Cliente consegue operar chamadas WhatsApp pelo navegador sem Asterisk.

### Fase 4 - Asterisk Separado

Objetivo:

Adicionar PABX real sem mexer no servidor principal.

Entregaveis:

- Container `asterisk`.
- Configuracao PJSIP/WebRTC.
- ARI habilitado somente em rede interna.
- Ramais por agente.
- Filas Asterisk.
- CDR.
- Gravacao opcional.
- Gateway controlando Asterisk via ARI.

Regra:

O navegador/painel nao acessa ARI direto. O gateway faz a mediacao.

### Fase 5 - Ponte Asterisk <-> WaCalls

Objetivo:

Permitir que chamadas WhatsApp entrem no fluxo do PABX real.

Hipoteses tecnicas para validar:

- Bridge RTP/SIP do Asterisk para audio PCM/WebRTC usado pela WaCalls.
- Canal customizado ou servico intermediario de media.
- External media/ARI para injetar audio em bridge controlada.
- Limites de codec, latencia, NAT e sincronizacao.

Criterio de aceite:

- Chamada recebida WhatsApp toca em fila Asterisk.
- Agente SIP/WebRTC atende.
- Audio bidirecional aceitavel.
- Encerramento e eventos consistentes.

### Fase 6 - Produto Whitelabel

Objetivo:

Empacotar para revenda.

Entregaveis:

- Nome comercial: Wozapi Calls ou Wozapi PABX.
- Branding por conta/revendedor.
- Planos:
  - agentes
  - linhas
  - chamadas simultaneas
  - retencao de historico
  - gravacao
- Pagina de licencas open source.
- Termos de uso para chamadas e gravacoes.
- Politica de retencao de audio/CDR.

## Licenca WaCalls

A WaCalls usa MIT. Whitelabel visual e permitido, mas o aviso de copyright e a licenca devem ser mantidos em copias ou partes substanciais do software.

Recomendado:

- Criar `THIRD_PARTY_NOTICES.md`.
- Manter LICENSE original no fork interno.
- Remover marca WaCalls apenas da interface publica.
- Nao remover autoria dos arquivos de licenca.

## Seguranca

Obrigatorio:

- WaCalls sem porta publica.
- ARI do Asterisk sem porta publica.
- Tokens internos fortes.
- Rede Docker privada.
- Volumes criptografados em producao.
- Backup separado de `wacalls.db`.
- Logs sem tokens e sem audio bruto.
- Gravacao somente com configuracao explicita.

## LGPD

Chamadas e gravacoes podem conter dados pessoais sensiveis. O modulo deve ter:

- retencao por conta
- permissao por agente
- registro de auditoria
- consentimento/aviso quando gravar
- exclusao/exportacao quando aplicavel
- mascaramento em logs

## Proxima Acao Recomendada

Executar a Fase 1 em ambiente local separado:

1. Clonar/forkar WaCalls.
2. Rodar em rede interna.
3. Validar chamada 1:1.
4. Medir latencia e estabilidade.
5. So depois iniciar o gateway.
