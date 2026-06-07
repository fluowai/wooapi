# WooAPI - Checklist de Producao

## Obrigatorio

- `DATABASE_URL` apontando para PostgreSQL/Supabase.
- `QUEUE_DRIVER=bullmq`.
- Redis com senha, AOF e volume persistente.
- `JWT_SECRET`, `WEBHOOK_SECRET`, `BRIDGE_TOKEN` e `WOOAPI_ADMIN_TOKEN` fortes.
- `APP_URL` HTTPS.
- `REQUIRE_PRODUCTION_READY=true` no container principal.
- Workers ativos: webhooks, messages, monitor, alerts, cleanup e chatwoot.
- Backup do PostgreSQL/Supabase pelo provedor ou `pg_dump`.
- Backup local de sessoes e midias por `POST /api/admin/backups`.

## Health Check

```bash
curl https://api.seudominio.com/health
```

O campo `production_ready` deve estar `true`. Se estiver `false`, leia `production_blockers`.

## Autenticacao

Endpoints regulares:

```bash
curl -H "token: $INSTANCE_TOKEN" https://api.seudominio.com/instance/status
```

Endpoints administrativos:

```bash
curl -H "admintoken: $WOOAPI_ADMIN_TOKEN" https://api.seudominio.com/instance/all
```

Compatibilidade Evolution/UazAPI com chave da instancia, limitada a conta da propria chave:

```bash
curl -H "token: $INSTANCE_TOKEN" https://api.seudominio.com/instance/all

curl -X POST https://api.seudominio.com/instance/create \
  -H "token: $INSTANCE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Atendimento 2","webhook_url":"https://seu-n8n.com/webhook/wooapi"}'
```

API v1:

```bash
curl -H "x-api-key: $INSTANCE_TOKEN" https://api.seudominio.com/api/v1/instances/17/status
```

## Exemplos de Envio

Texto:

```bash
curl -X POST https://api.seudominio.com/send/text \
  -H "token: $INSTANCE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"number":"5548999999999","text":"Teste WooAPI"}'
```

Localizacao:

```bash
curl -X POST https://api.seudominio.com/send/location \
  -H "token: $INSTANCE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"number":"5548999999999","latitude":-27.5949,"longitude":-48.5482,"name":"WooAPI","address":"Florianopolis - SC"}'
```

Contato:

```bash
curl -X POST https://api.seudominio.com/send/contact \
  -H "token: $INSTANCE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"number":"5548999999999","name":"Suporte WooAPI","phone":"5548999999999"}'
```

Campanha:

```bash
curl -X POST https://api.seudominio.com/sender/create \
  -H "token: $INSTANCE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Campanha teste","message":"Ola {{nome}}","min_delay_ms":3000,"max_delay_ms":9000,"limit_per_instance":1}'
```

## Observabilidade

Painel admin:

```bash
curl -H "Authorization: Bearer $JWT" https://api.seudominio.com/api/admin/wooapi-monitor
```

Logs:

```bash
curl -H "Authorization: Bearer $JWT" "https://api.seudominio.com/api/admin/logs?type=webhooks"
```

Alertas:

```bash
curl -H "Authorization: Bearer $JWT" https://api.seudominio.com/api/admin/alerts
```

## Backup

Criar backup operacional:

```bash
curl -X POST -H "Authorization: Bearer $JWT" https://api.seudominio.com/api/admin/backups
```

Listar backups:

```bash
curl -H "Authorization: Bearer $JWT" https://api.seudominio.com/api/admin/backups
```

Restore local so deve ser feito em manutencao com `ALLOW_RESTORE=true`.
