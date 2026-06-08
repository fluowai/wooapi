# WooAPI - Documentacao Tecnica

Esta documentacao descreve a API publica da WooAPI para envio e recebimento de mensagens WhatsApp por instancias independentes, webhooks, integracoes, campanhas, CRM e administracao comercial.

Base local:

```text
http://localhost:3002
```

Em producao, use o dominio configurado em `APP_URL`.

Links publicos:

```text
Pagina publica: /docs/wooapi
Swagger:        /docs
OpenAPI:        /openapi.json
Postman:        /postman/wooapi.postman_collection.json
Termos:         /terms
```

## Conceitos

### Conta

Conta e o cadastro comercial do cliente, revendedor ou owner. Conta usa JWT para acessar painel, campanhas, CRM, planos e administracao.

### Instancia

Instancia e uma sessao WhatsApp independente. Cada instancia possui:

- `id`
- `api_key`
- status de conexao
- telefone conectado
- QR Code quando necessario
- webhook proprio
- logs de mensagens
- logs de webhooks
- limites por plano

### API key

Cada instancia possui uma API key no formato:

```text
woo_xxxxxxxxx
```

Use essa chave nos endpoints da instancia.

### Webhook

Webhook e a URL do sistema externo que recebera eventos da WooAPI, como mensagem recebida, mensagem enviada, desconexao, QR expirado e falhas operacionais.

## Autenticacao

### Endpoints da instancia

Preferencial:

```http
x-api-key: woo_sua_api_key
```

Tambem aceito em endpoints especificos:

```http
token: woo_sua_api_key
```

Nos endpoints compativeis com Evolution/UazAPI, a chave da instancia tambem pode gerenciar instancias da mesma conta:

```http
GET  /instance/all
POST /instance/create
```

Com `token` ou `x-api-key`, esses endpoints listam/criam apenas instancias da conta dona da chave. Com `admintoken`, continuam tendo escopo administrativo global.

### Endpoints de conta e painel

Use JWT retornado em `/api/auth/login`:

```http
Authorization: Bearer jwt_da_conta
```

### Endpoints administrativos externos

Use o token administrativo WooAPI:

```http
admintoken: valor_do_WOOAPI_ADMIN_TOKEN
```

Configure `WOOAPI_ADMIN_TOKEN` no ambiente de producao.

## Criar Instancia

```bash
curl -X POST http://localhost:3002/api/v1/instances \
  -H "Authorization: Bearer JWT_DA_CONTA" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Atendimento Comercial",
    "webhook_url": "https://seu-n8n.com/webhook/wooapi"
  }'
```

Resposta:

```json
{
  "success": true,
  "message": "Instancia criada com sucesso",
  "data": {
    "id": 17,
    "name": "Atendimento Comercial",
    "status": "created",
    "api_key": "woo_xxx",
    "webhook_secret": "whsec_xxx",
    "webhook": {
      "webhooks_url": "https://api.seudominio.com/api/v1/instances/17/webhooks",
      "webhook_events_url": "https://api.seudominio.com/api/v1/instances/17/webhook-events",
      "webhook_logs_url": "https://api.seudominio.com/api/v1/instances/17/webhook-logs",
      "webhook_test_url": "https://api.seudominio.com/api/v1/instances/17/webhook/test",
      "signing_header": "X-WooAPI-Signature",
      "signature_format": "sha256=<hmac_sha256_raw_body_hex>",
      "secret": "whsec_xxx"
    },
    "default_webhook": {
      "id": 1,
      "name": "Webhook padrao",
      "url": "https://seu-n8n.com/webhook/wooapi",
      "is_active": true
    }
  }
}
```

Se `webhook_url` for enviado na criacao, a WooAPI ja cadastra esse destino como primeiro webhook ativo.

## Fluxo Basico

1. Criar instancia.
2. Copiar `api_key`.
3. Conectar e ler QR Code.
4. Enviar mensagem de teste.
5. Configurar webhook para receber eventos.
6. Integrar com n8n, CRM, Chatwoot, Typebot ou sistema proprio.

## Instancias

```http
GET    /api/v1/instances
POST   /api/v1/instances
GET    /api/v1/instances/:id
GET    /api/v1/instances/:id/status
GET    /api/v1/instances/:id/qr
POST   /api/v1/instances/:id/connect
POST   /api/v1/instances/:id/reconnect
POST   /api/v1/instances/:id/logout
PATCH  /api/v1/instances/:id
DELETE /api/v1/instances/:id
POST   /api/v1/instances/:id/api-key/regenerate
```

### Conectar

```bash
curl -X POST http://localhost:3002/api/v1/instances/17/connect \
  -H "x-api-key: woo_sua_api_key"
```

### Status

```bash
curl http://localhost:3002/api/v1/instances/17/status \
  -H "x-api-key: woo_sua_api_key"
```

## Mensagens

```http
POST /api/v1/instances/:id/send-text
POST /api/v1/instances/:id/send-media
POST /api/v1/instances/:id/send-location
POST /api/v1/instances/:id/send-contact
POST /api/v1/instances/:id/send-reply
POST /api/v1/instances/:id/messages/react
POST /api/v1/instances/:id/messages/read
POST /api/v1/instances/:id/messages/edit
POST /api/v1/instances/:id/messages/delete
POST /api/v1/instances/:id/messages/download
POST /api/v1/instances/:id/presence
POST /api/v1/send
```

### Enviar texto

```bash
curl -X POST http://localhost:3002/api/v1/instances/17/send-text \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5548999999999",
    "text": "Ola pela WooAPI"
  }'
```

Para enviar de forma assíncrona, informe `async: true` ou `mode: "async"`. A API retorna `202` quando a mensagem entra na fila; o resultado final chega por webhook `message.sent` ou `message.failed`.

```json
{
  "number": "5548999999999",
  "text": "Ola pela WooAPI",
  "async": true
}
```

### Enviar midia

```bash
curl -X POST http://localhost:3002/api/v1/instances/17/send-media \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5548999999999",
    "mediaUrl": "https://example.com/arquivo.pdf",
    "caption": "Arquivo enviado pela WooAPI",
    "mime_type": "application/pdf",
    "file_name": "arquivo.pdf",
    "async": true
  }'
```

### Enviar localizacao

```bash
curl -X POST http://localhost:3002/api/v1/instances/17/send-location \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5548999999999",
    "latitude": -27.5949,
    "longitude": -48.5482,
    "name": "WooAPI",
    "address": "Florianopolis - SC"
  }'
```

### Enviar contato

```bash
curl -X POST http://localhost:3002/api/v1/instances/17/send-contact \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5548999999999",
    "name": "Atendimento WooAPI",
    "phone": "5548933806836"
  }'
```

### Responder citando mensagem

```bash
curl -X POST http://localhost:3002/api/v1/instances/17/send-reply \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "jid": "5548999999999@s.whatsapp.net",
    "message_id": "3EB012345678",
    "text": "Respondendo sua mensagem."
  }'
```

## Webhooks

```http
GET    /api/v1/instances/:id/webhooks
POST   /api/v1/instances/:id/webhooks
PATCH  /api/v1/instances/:id/webhooks/:webhookId
DELETE /api/v1/instances/:id/webhooks/:webhookId
POST   /api/v1/instances/:id/webhooks/:webhookId/test
GET    /api/v1/instances/:id/webhook-logs
POST   /api/v1/webhook-logs/:logId/retry
PATCH  /api/v1/instances/:id/webhook
POST   /api/v1/instances/:id/webhook/test
GET    /api/v1/instances/:id/webhook-events
POST   /api/v1/instances/:id/webhook-events/:eventId/retry
GET    /api/v1/instances/:id/logs
```

### Criar webhook

```bash
curl -X POST http://localhost:3002/api/v1/instances/17/webhooks \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "n8n Atendimento",
    "url": "https://seu-n8n.com/webhook/wooapi",
    "events": ["message.received", "message.sent", "instance.connected", "instance.disconnected"],
    "retry_enabled": true,
    "max_attempts": 5
  }'
```

### Assinatura HMAC

Cada entrega HTTP inclui:

```http
X-WooAPI-Signature: sha256=<hmac_sha256_raw_body_hex>
```

Use o secret do webhook ou `webhook_secret` da instancia para validar o corpo bruto recebido.

### Eventos principais

```text
message.received
message.sent
message.read
message.edited
message.deleted
message.reaction
instance.connected
instance.disconnected
instance.qr
instance.qr_expired
webhook.sent
webhook.failed
webhook.retrying
```

## Integracao n8n

### Enviar mensagem usando HTTP Request

Configuracao do node:

```json
{
  "method": "POST",
  "url": "https://api.seudominio.com/api/v1/instances/17/send-text",
  "headers": {
    "x-api-key": "woo_sua_api_key",
    "Content-Type": "application/json"
  },
  "body": {
    "number": "5548999999999",
    "text": "Ola, {{$json.nome}}!"
  }
}
```

### Receber eventos usando Webhook Trigger

1. Crie um node Webhook no n8n.
2. Copie a Production URL.
3. Cadastre essa URL em `/api/v1/instances/:id/webhooks`.
4. Trate eventos `message.received`.
5. Responda usando HTTP Request para `/send-text`.

## Integracoes

```http
GET /api/v1/instances/:id/integrations
PUT /api/v1/instances/:id/integrations/:provider
```

Providers suportados no painel:

```text
n8n
typebot
chatwoot
```

## Contatos e Chats

```http
GET  /api/v1/instances/:id/contacts
POST /api/v1/instances/:id/contacts/check
POST /api/v1/instances/:id/contacts/info
POST /api/v1/instances/:id/contacts/block
POST /api/v1/instances/:id/chats/state
```

## Perfil

```http
GET  /api/v1/instances/:id/profile
POST /api/v1/instances/:id/profile/name
POST /api/v1/instances/:id/profile/status
POST /api/v1/instances/:id/profile/photo
```

## Grupos

```http
GET  /api/v1/instances/:id/groups
POST /api/v1/instances/:id/groups
POST /api/v1/instances/:id/groups/participants
POST /api/v1/instances/:id/groups/settings
```

## Campanhas e CRM

```http
POST /api/campaigns
POST /api/campaigns/:id/recipients
POST /api/campaigns/:id/start
POST /api/campaigns/:id/pause
POST /api/campaigns/:id/cancel
GET  /api/campaigns/:id/report
GET  /api/quick-replies
POST /api/quick-replies
GET  /api/leads/:id/details
POST /api/leads/:id/notes
POST /api/leads/:id/tags
PUT  /api/leads/:id/custom-fields
```

## Administracao

```http
GET  /health
GET  /api/admin/overview
GET  /api/admin/wooapi-monitor
GET  /api/admin/accounts
GET  /api/admin/plans
POST /api/admin/backups
GET  /api/admin/backups
```

## Postman

Baixe a collection:

```text
/postman/wooapi.postman_collection.json
```

Variaveis principais:

```text
baseUrl
jwt
instanceId
instanceToken
number
webhookUrl
adminToken
```

## Limites e Boas Praticas

- Configure rate limit por plano e por instancia.
- Use delays em campanhas.
- Evite disparos sem consentimento.
- Monitore desconexoes e QR expirado.
- Use Redis/BullMQ em producao.
- Use backup de banco, sessoes e midias.
- Configure billing e readiness antes de venda aberta.

## Observacao Comercial

A WooAPI e uma solucao de automacao para WhatsApp baseada em sessoes conectadas pelo cliente. O uso deve respeitar consentimento, politicas comerciais, limites de envio, boas praticas anti-spam e termos aplicaveis. Botoes nativos oficiais nao fazem parte do produto vendavel desta versao; use texto, links, midia e webhooks.
