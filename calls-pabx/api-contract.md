# Wozapi Calls Gateway - Contrato Proposto

Base local sugerida:

```text
http://localhost:3100
```

Autenticacao:

```http
Authorization: Bearer <jwt_wozapi_ou_token_interno>
```

## Health

```http
GET /health
```

Resposta:

```json
{
  "ok": true,
  "gateway": "ready",
  "wacalls": "ready",
  "asterisk": "disabled"
}
```

## Linhas De Chamada

Uma linha representa uma sessao WhatsApp habilitada para ligacoes.

```http
GET /v1/call-lines
POST /v1/call-lines
GET /v1/call-lines/:id
POST /v1/call-lines/:id/pair
POST /v1/call-lines/:id/logout
DELETE /v1/call-lines/:id
```

Criar linha:

```json
{
  "instance_id": 17,
  "name": "Comercial 1",
  "provider": "wacalls"
}
```

## Agentes

```http
GET /v1/agents
POST /v1/agents
PATCH /v1/agents/:id
PATCH /v1/agents/me/status
```

Status aceitos:

```text
online
busy
away
offline
```

## Filas

```http
GET /v1/queues
POST /v1/queues
PATCH /v1/queues/:id
POST /v1/queues/:id/members
DELETE /v1/queues/:id/members/:agentId
```

Estrategias iniciais:

```text
round_robin
least_busy
ring_all
manual
```

## Chamadas

Iniciar chamada:

```http
POST /v1/calls
```

```json
{
  "line_id": 1,
  "to": "5548999999999",
  "queue_id": null,
  "metadata": {
    "lead_id": 123
  }
}
```

Operacoes:

```http
GET    /v1/calls
GET    /v1/calls/:id
POST   /v1/calls/:id/accept
POST   /v1/calls/:id/reject
POST   /v1/calls/:id/transfer
DELETE /v1/calls/:id
```

Transferencia futura:

```json
{
  "target_type": "agent",
  "target_id": 12
}
```

## Eventos Em Tempo Real

```http
GET /v1/events
```

SSE ou WebSocket futuro. Envelope:

```json
{
  "event_id": "call_evt_01",
  "event": "call.incoming",
  "account_id": 1,
  "line_id": 1,
  "call_id": "call_abc",
  "timestamp": "2026-07-01T12:00:00.000Z",
  "data": {}
}
```

## Webhooks Publicos

Eventos:

```text
call.incoming
call.ringing
call.answered
call.rejected
call.missed
call.ended
call.failed
call.recording.available
agent.status.changed
queue.call.assigned
```

## Historico

```http
GET /v1/call-history
GET /v1/call-history/:id
```

Filtros:

```text
account_id
line_id
agent_id
queue_id
direction
status
from
to
```

## Administracao Interna

Somente owner/super admin:

```http
GET  /admin/engines
POST /admin/engines/wacalls/restart
GET  /admin/asterisk/status
GET  /admin/metrics
```
