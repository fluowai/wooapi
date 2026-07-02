# Wozapi Webhooks

Webhooks da Wozapi sao configurados por instancia e entregues por fila Redis/BullMQ. A API principal apenas valida a configuracao, normaliza o evento e cria um job em `Wozapi:webhook-delivery`; a entrega HTTP acontece no `Wozapi-webhook-worker`.

## Endpoints

Autenticacao: use a API key da instancia.

```http
Authorization: Bearer WOO_INSTANCE_API_KEY
```

```http
GET    /api/v1/instances/:instance_id/webhooks
POST   /api/v1/instances/:instance_id/webhooks
PATCH  /api/v1/instances/:instance_id/webhooks/:webhook_id
DELETE /api/v1/instances/:instance_id/webhooks/:webhook_id
POST   /api/v1/instances/:instance_id/webhooks/:webhook_id/test
GET    /api/v1/instances/:instance_id/webhook-logs
POST   /api/v1/webhook-logs/:log_id/retry
```

O endpoint legado abaixo continua disponivel para compatibilidade:

```http
PATCH /api/v1/instances/:instance_id/webhook
POST  /api/v1/instances/:instance_id/webhook/test
GET   /api/v1/instances/:instance_id/webhook-events
POST  /api/v1/instances/:instance_id/webhook-events/:event_id/retry
```

## Criar Webhook

```http
POST /api/v1/instances/123/webhooks
Content-Type: application/json
Authorization: Bearer WOO_INSTANCE_API_KEY
```

```json
{
  "name": "Webhook n8n",
  "url": "https://n8n.cliente.com/webhook/Wozapi",
  "events": ["message.received", "message.sent", "instance.disconnected"],
  "retry_enabled": true,
  "max_attempts": 5
}
```

A Wozapi gera automaticamente o `secret` do webhook e o retorna apenas na criacao ou ao rotacionar o segredo.

## Entrega

Headers enviados:

```http
Content-Type: application/json
X-Wooapi-Event: message.received
X-Wooapi-Instance: inst_123
X-Wooapi-Delivery: delivery_456
X-Wooapi-Timestamp: 2026-05-27T14:30:00.000Z
X-Wooapi-Signature: sha256=HMAC_SHA256
```

Payload padrao:

```json
{
  "event_id": "evt_01hx000000000000",
  "event": "message.received",
  "tenant_id": "tenant_123",
  "instance_id": "inst_123",
  "timestamp": "2026-05-27T14:30:00.000Z",
  "source": "Wozapi",
  "data": {
    "message": {
      "id": "msg_123",
      "type": "text",
      "text": "Ola, tenho interesse"
    }
  }
}
```

## Assinatura HMAC

Calcule o HMAC SHA-256 usando o corpo bruto recebido e o `secret` do webhook:

```txt
sha256=hex(hmac_sha256(raw_body, webhook_secret))
```

Compare com `X-Wooapi-Signature` usando comparacao constante no seu backend.

## Retry E Logs

Falhas HTTP, timeout ou erro de rede geram nova tentativa com backoff exponencial de 30 segundos. Cada tentativa cria uma linha em `webhook_delivery_logs` com status HTTP, sucesso/falha, tentativa, tempo de resposta, erro e payload enviado.

Para reenviar manualmente uma tentativa:

```http
POST /api/v1/webhook-logs/:log_id/retry
Authorization: Bearer WOO_INSTANCE_API_KEY
```
