# Wozapi Events

Todos os eventos publicos da Wozapi usam o mesmo envelope:

```json
{
  "event_id": "evt_01hx000000000000",
  "event": "message.received",
  "tenant_id": "tenant_123",
  "instance_id": "inst_123",
  "timestamp": "2026-05-27T14:30:00.000Z",
  "source": "Wozapi",
  "data": {}
}
```

## Mensagens

- `message.received`
- `message.sent`
- `message.delivered`
- `message.read`
- `message.failed`
- `message.deleted`

## Instancias

- `instance.qr`
- `instance.connected`
- `instance.disconnected`
- `instance.reconnecting`
- `instance.logged_out`
- `instance.connection_lost`
- `instance.health_checked`

## Midia

- `media.received`
- `media.uploaded`
- `media.failed`

## Grupos

- `group.message.received`
- `group.participant.added`
- `group.participant.removed`

## Webhooks

- `webhook.sent`
- `webhook.failed`
- `webhook.retrying`
- `webhook.disabled`

## Sistema

- `system.degraded`
- `system.outage`
- `system.recovered`
