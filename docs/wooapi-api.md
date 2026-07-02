# Wozapi - Documentacao Tecnica

Esta documentacao descreve a API publica da Wozapi para envio e recebimento de mensagens WhatsApp por instancias independentes, webhooks, integracoes, campanhas, CRM e administracao comercial.

Base oficial da API e do painel:

```text
https://painel.wozapi.com.br
```

Site de vendas: `https://wozapi.com.br`.

Links publicos:

```text
Pagina publica: /docs/wozapi
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

Webhook e a URL do sistema externo que recebera eventos da Wozapi, como mensagem recebida, mensagem enviada, desconexao, QR expirado e falhas operacionais.

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

Use o token administrativo Wozapi:

```http
admintoken: valor_do_WOOAPI_ADMIN_TOKEN
```

Configure `WOOAPI_ADMIN_TOKEN` no ambiente de producao.

## Criar Instancia

```bash
curl -X POST https://painel.wozapi.com.br/api/v1/instances \
  -H "Authorization: Bearer JWT_DA_CONTA" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Atendimento Comercial",
    "webhook_url": "https://seu-n8n.com/webhook/wozapi"
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
      "webhooks_url": "https://painel.wozapi.com.br/api/v1/instances/17/webhooks",
      "webhook_events_url": "https://painel.wozapi.com.br/api/v1/instances/17/webhook-events",
      "webhook_logs_url": "https://painel.wozapi.com.br/api/v1/instances/17/webhook-logs",
      "webhook_test_url": "https://painel.wozapi.com.br/api/v1/instances/17/webhook/test",
      "signing_header": "X-Wooapi-Signature",
      "signature_format": "sha256=<hmac_sha256_raw_body_hex>",
      "secret": "whsec_xxx"
    },
    "default_webhook": {
      "id": 1,
      "name": "Webhook padrao",
      "url": "https://seu-n8n.com/webhook/wozapi",
      "is_active": true
    }
  }
}
```

Se `webhook_url` for enviado na criacao, a Wozapi ja cadastra esse destino como primeiro webhook ativo.

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
curl -X POST https://painel.wozapi.com.br/api/v1/instances/17/connect \
  -H "x-api-key: woo_sua_api_key"
```

### Status

```bash
curl https://painel.wozapi.com.br/api/v1/instances/17/status \
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
curl -X POST https://painel.wozapi.com.br/api/v1/instances/17/send-text \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5548999999999",
    "text": "Ola pela Wozapi"
  }'
```

### Envio assíncrono de mensagens

Use envio assíncrono quando o cliente da API não deve aguardar o WhatsApp confirmar o envio no mesmo request. Informe `async: true`, `async_send: true`, `send_async: true` ou `mode: "async"` no corpo da requisição.

Quando aceito, a API retorna HTTP `202` com `queued: true`, `jobId`, `pendingMessageId` e a mensagem salva como `pending`. O resultado final chega depois pelos webhooks `message.sent` ou `message.failed`.

> Importante: o envio assíncrono requer `QUEUE_DRIVER=bullmq`, Redis disponível e o worker `npm run worker:messages` em execução. Se a fila não estiver disponível, a API retorna `QUEUE_UNAVAILABLE`.

```json
{
  "number": "5548999999999",
  "text": "Ola pela Wozapi",
  "async": true
}
```

### Enviar midia

```bash
curl -X POST https://painel.wozapi.com.br/api/v1/instances/17/send-media \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5548999999999",
    "mediaUrl": "https://example.com/arquivo.pdf",
    "caption": "Arquivo enviado pela Wozapi",
    "mime_type": "application/pdf",
    "file_name": "arquivo.pdf",
    "async": true
  }'
```

### Enviar localizacao

```bash
curl -X POST https://painel.wozapi.com.br/api/v1/instances/17/send-location \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5548999999999",
    "latitude": -27.5949,
    "longitude": -48.5482,
    "name": "Wozapi",
    "address": "Florianopolis - SC"
  }'
```

### Enviar contato

```bash
curl -X POST https://painel.wozapi.com.br/api/v1/instances/17/send-contact \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "5548999999999",
    "name": "Atendimento Wozapi",
    "phone": "5548933806836"
  }'
```

### Responder citando mensagem

```bash
curl -X POST https://painel.wozapi.com.br/api/v1/instances/17/send-reply \
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
curl -X POST https://painel.wozapi.com.br/api/v1/instances/17/webhooks \
  -H "x-api-key: woo_sua_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "n8n Atendimento",
    "url": "https://seu-n8n.com/webhook/wozapi",
    "events": ["message.received", "message.sent", "instance.connected", "instance.disconnected"],
    "retry_enabled": true,
    "max_attempts": 5
  }'
```

### Assinatura HMAC

Cada entrega HTTP inclui:

```http
X-Wooapi-Signature: sha256=<hmac_sha256_raw_body_hex>
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
  "url": "https://painel.wozapi.com.br/api/v1/instances/17/send-text",
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

### Fluxo assistido recomendado

Para reduzir configuracao manual, use a aba **Conectores** do painel. Ela centraliza a instancia, API key, endpoints, webhooks, exemplos e status de prontidao.

Ordem sugerida:

1. Selecione a instancia conectada.
2. Copie a URL base e a API key exibidas no painel.
3. Escolha o provedor: n8n, Typebot ou Chatwoot.
4. Preencha apenas os campos do provedor.
5. Salve e ative.
6. No n8n, crie o webhook pelo botao do painel. No Chatwoot, salve a configuracao para acionar o auto-registro do webhook no inbox.
7. Valide em **Saude da Plataforma** usando logs de webhooks e eventos.

Campos por provedor:

| Provedor | Campos | Resultado |
| --- | --- | --- |
| n8n | Production URL do Webhook e token opcional | A Wozapi entrega eventos no workflow e o n8n responde via HTTP Request para `/send-text`. |
| Typebot | URL base, Public ID e API token | Mensagens recebidas iniciam ou continuam uma sessao Typebot e as respostas voltam ao WhatsApp. |
| Chatwoot | URL, API Access Token, Account ID e Inbox ID | Conversas entram no inbox e respostas de agentes saem pela instancia Wozapi. |

Exemplo minimo para responder mensagens a partir de qualquer ferramenta HTTP:

```bash
curl -X POST https://painel.wozapi.com.br/api/v1/instances/17/send-text \
  -H "Content-Type: application/json" \
  -H "x-api-key: woo_sua_api_key" \
  -d '{"number":"5548999999999","text":"Ola, tudo certo?"}'
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

## LGPD e Privacidade

```http
GET  /privacy
POST /api/data/export
POST /api/data/anonymize
POST /api/data/consent
GET  /api/data/consent/:userId
GET  /api/data/requests
```

### Politica de Privacidade

```bash
curl http://localhost:3000/privacy
```

Retorna a politica de privacidade completa em markdown (ou HTML se o arquivo `docs/privacy.md` nao existir).

### Exportar dados do titular (DSAR)

```bash
curl -X POST http://localhost:3000/api/data/export \
  -H "Authorization: Bearer JWT_DA_CONTA"
```

Resposta:

```json
{
  "success": true,
  "requestId": 1,
  "data": {
    "exportedAt": "2026-06-09T...",
    "account": { ... },
    "instances": [ ... ],
    "conversations": [ ... ],
    "messages": [ ... ],
    "leads": [ ... ],
    "consentRecords": [ ... ]
  }
}
```

### Anonimizar dados

```bash
curl -X POST http://localhost:3000/api/data/anonymize \
  -H "Authorization: Bearer JWT_DA_CONTA" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "all"
  }'
```

`scope` pode ser: `account`, `messages`, `leads`, `conversations` ou `all`.

### Registrar consentimento

```bash
curl -X POST http://localhost:3000/api/data/consent \
  -H "Authorization: Bearer JWT_DA_CONTA" \
  -H "Content-Type: application/json" \
  -d '{
    "purpose": "marketing",
    "consent_type": "lgpd",
    "granted": true,
    "userId": 42
  }'
```

Para revogar, envie `granted: false`.

### Consultar consentimentos

```bash
curl http://localhost:3000/api/data/consent/me \
  -H "Authorization: Bearer JWT_DA_CONTA"
```

Use `me` para consultar consentimentos da conta ou um `userId` especifico.

### Historico de solicitacoes

```bash
curl http://localhost:3000/api/data/requests \
  -H "Authorization: Bearer JWT_DA_CONTA"
```

## MCP Server (Model Context Protocol)

A Wozapi fornece um servidor MCP (Model Context Protocol) que permite que assistentes IA (Claude Desktop, Cursor, etc.) interajam diretamente com a API do WhatsApp.

### Arquitetura

```
mcp-server/
  src/
    index.ts                  # Entrypoint stdio
    lib/
      config.ts               # Configuracao via env
      api.ts                  # HTTP client para API Wozapi
    tools/
      messaging.ts            # Envio de mensagens
      groups.ts               # Gerenciamento de grupos
      contacts.ts             # Consulta de contatos
      instances.ts            # Gerenciamento de instancias
    resources/
      conversations.ts        # Resources de conversas/instancias/mensagens
    prompts/
      templates.ts            # Templates de prompt para IA
  package.json
  tsconfig.json
```

### Configuracao

Variaveis de ambiente:

```env
WOOAPI_BASE_URL=https://painel.wozapi.com.br
WOOAPI_API_KEY=woo_sua_api_key
WOOAPI_INSTANCE_ID=17
```

### Ferramentas disponiveis (17 tools)

| Categoria | Tool | Descricao |
|-----------|------|-----------|
| **Messaging** | `send_message` | Enviar texto WhatsApp |
| | `send_media` | Enviar midia (imagem/audio/video/doc) |
| | `send_buttons` | Enviar botoes interativos (ate 3) |
| | `send_list` | Enviar lista interativa com secoes |
| | `send_reply` | Responder citando mensagem |
| | `send_location` | Compartilhar localizacao |
| **Groups** | `get_groups` | Listar grupos |
| | `get_group_info` | Detalhes do grupo |
| | `create_group` | Criar grupo |
| | `add_group_participants` | Adicionar participantes |
| | `remove_group_participants` | Remover participantes |
| | `promote_group_participants` | Promover a admin |
| | `demote_group_participants` | Rebaixar admin |
| **Contacts** | `get_contacts` | Listar contatos |
| | `get_contact_info` | Detalhes do contato |
| | `check_recipient` | Verificar se numero esta no WhatsApp |
| **Instances** | `get_instances` | Listar instancias |
| | `get_instance_status` | Status da conexao |
| | `get_conversations` | Listar conversas |
| | `get_conversation_messages` | Mensagens da conversa |
| | `get_messages` | Todas as mensagens |

### Resources disponiveis (3 resources)

| URI | Descricao |
|-----|-----------|
| `wooapi://conversations` | Lista todas as conversas da conta |
| `wooapi://instances` | Lista todas as instancias da conta |
| `wooapi://messages` | Lista todas as mensagens da conta |

### Prompts disponiveis (4 prompts)

| Nome | Descricao | Argumentos |
|------|-----------|------------|
| `customer_support_agent` | Agente de atendimento via WhatsApp | `instanceId`, `language` (pt-BR/en) |
| `broadcast_campaign` | Campanha de disparo em massa | `instanceId`, `audience` |
| `group_management` | Gerenciamento de grupos | `instanceId`, `action` |
| `contact_research` | Pesquisa de contatos | `instanceId` |

### Uso com Claude Desktop

Adicione ao `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "Wozapi": {
      "command": "node",
      "args": ["caminho/para/mcp-server/dist/index.js"],
      "env": {
        "WOOAPI_BASE_URL": "https://painel.wozapi.com.br",
        "WOOAPI_API_KEY": "woo_sua_api_key",
        "WOOAPI_INSTANCE_ID": "17"
      }
    }
  }
}
```

### Uso com Cursor

Nas configuracoes do Cursor, adicione um MCP Server apontando para:

```
comando: node
argumentos: [caminho/para/mcp-server/dist/index.js]
variaveis:
  WOOAPI_BASE_URL: https://painel.wozapi.com.br
  WOOAPI_API_KEY: woo_sua_api_key
  WOOAPI_INSTANCE_ID: 17
```

### Desenvolvimento

```bash
cd mcp-server
npm install
npm run dev    # tsx watch -- hot reload
npm run build  # compilar para dist/
npm start      # rodar versao compilada
```

## Observacao Comercial

A Wozapi e uma solucao de automacao para WhatsApp baseada em sessoes conectadas pelo cliente. O uso deve respeitar consentimento, politicas comerciais, limites de envio, boas praticas anti-spam, termos aplicaveis e a LGPD. Botoes nativos oficiais nao fazem parte do produto vendavel desta versao; use texto, links, midia e webhooks.
