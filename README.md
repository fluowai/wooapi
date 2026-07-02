# Wozapi

Sua infraestrutura própria para vender e gerenciar instâncias WhatsApp com API, Webhook e WebSocket.

## Visão Geral

O Wozapi é uma plataforma SaaS API-first para operação, venda e revenda de instâncias WhatsApp autônomas.

O servidor único entrega:

- painel web
- API pública `/api/v1`
- WebSocket / Socket.IO
- webhooks por instância
- autenticação e contas SaaS
- integração com Wozapi Core

## Papéis

- Super Admin: gerencia planos, contas, cotas, monitoramento, logs e suporte.
- Revendedor: cria clientes filhos e distribui cotas dentro do limite contratado.
- Cliente final: cria instâncias, conecta WhatsApp, usa API key, webhook e websocket.

## Rodando Localmente

```bash
npm install
npm run dev
```

Acesse `http://localhost:3000`.

## Variáveis

```env
APP_URL=https://seu-dominio.com
CORS_ORIGIN=*
BRIDGE_TOKEN=troque-por-um-token-forte
JWT_SECRET=troque-por-um-segredo-forte
WEBHOOK_SECRET=troque-por-um-segredo-forte
DATABASE_URL=
NODE_ENV=production
```

Sem `DATABASE_URL`, o Wozapi usa SQLite local. Com `DATABASE_URL`, a implantação fica preparada para PostgreSQL em produção.

## Motor Wozapi 2.0

O core atual continua disponível. Para ativar o motor Wozapi 2.0, configure:

```env
WOZAPI_ENGINE=v2
WOZAPI_V2_BRIDGE_URL=http://127.0.0.1:3003
WOZAPI_V2_BRIDGE_PORT=3003
WOZAPI_V2_UPSTREAM_URL=http://127.0.0.1:3004
WOZAPI_V2_UPSTREAM_API_KEY=
WOZAPI_V2_PUBLIC_BRIDGE_URL=https://core.seu-dominio.com
BRIDGE_DEVICE_NAME=Wozapi
WOZAPI_V2_DEVICE_NAME=Wozapi2
WOZAPI_V2_BROWSER_NAME=Wozapi2
```

O Wozapi 1.0 usa `BRIDGE_URL=http://127.0.0.1:3001`. O Wozapi 2.0 usa `WOZAPI_V2_BRIDGE_URL=http://127.0.0.1:3003`. Ao criar uma instancia no painel, escolha a versao do motor.

## API Pública

A API pública usa API key por instância:

```bash
x-api-key: woo_sua_chave
```

ou:

```bash
Authorization: Bearer woo_sua_chave
```

Resposta de sucesso:

```json
{
  "success": true,
  "message": "Operação realizada com sucesso",
  "data": {}
}
```

Resposta de erro:

```json
{
  "success": false,
  "code": "ERROR_CODE",
  "message": "Mensagem clara",
  "details": {}
}
```

## Endpoints Principais

- `GET /api/v1/instances`
- `POST /api/v1/instances`
- `GET /api/v1/instances/:id`
- `GET /api/v1/instances/:id/status`
- `GET /api/v1/instances/:id/qr`
- `POST /api/v1/instances/:id/connect`
- `POST /api/v1/instances/:id/reconnect`
- `POST /api/v1/instances/:id/logout`
- `PATCH /api/v1/instances/:id/webhook`
- `POST /api/v1/instances/:id/webhook/test`
- `GET /api/v1/instances/:id/webhook-events`
- `POST /api/v1/instances/:id/webhook-events/:eventId/retry`
- `POST /api/v1/instances/:id/send-text`
- `POST /api/v1/instances/:id/send-media`
- `PATCH /api/v1/instances/:id`
- `DELETE /api/v1/instances/:id`

Botões interativos nativos não são anunciados na versão vendável. Esse tipo de
mensagem depende da API oficial do WhatsApp para entrega/renderização confiável.

## Webhook

Cada instância pode ter webhook próprio com assinatura HMAC.

Headers enviados:

- `X-Wooapi-Event`
- `X-Wooapi-Signature`
- `X-Wooapi-Instance`
- `X-Wooapi-Timestamp`

Eventos mínimos:

- `connection.update`
- `qrcode.updated`
- `message.received`
- `message.sent`
- `message.status`
- `message.error`
- `instance.connected`
- `instance.disconnected`

## WebSocket

```js
import { io } from "socket.io-client";

const socket = io("https://seu-dominio.com", {
  query: { apiKey: "woo_sua_chave" }
});

socket.on("instance.status", console.log);
socket.on("instance.qr", console.log);
socket.on("message.new", console.log);
socket.on("message.status", console.log);
socket.on("connection.status", console.log);
```

## Integrações

### n8n

**n8n Community Node** (n8n-nodes-wooapi):
- Node de ação: enviar texto, mídia, localização, contato, reply
- Node de trigger: receber eventos do WhatsApp em tempo real
- Autocomplete de instâncias, tratamento de erros, credenciais via API key

Para instalar no n8n: **Settings → Community Nodes → Install** → `n8n-nodes-wooapi`

Ou via HTTP Request manual:
- Receba eventos via webhook (endpoint `/api/v1/instances/:id/webhooks`)
- Responda com POST para `/api/v1/instances/:id/send-text`

### Chatwoot (2-way sync)

- **WhatsApp → Chatwoot**: mensagens recebidas são automaticamente sincronizadas como `incoming` no Chatwoot (texto + mídia)
- **Chatwoot → WhatsApp**: quando um agente responde, o webhook do Chatwoot envia a mensagem para o WhatsApp
- **Status sync**: avisos de entrega e leitura são sincronizados para o Chatwoot
- **Auto-registro**: ao configurar a integração, o webhook no Chatwoot é registrado automaticamente

Configuração:
```
PUT /chatwoot/config
{
  "apiUrl": "https://app.chatwoot.com",
  "apiToken": "seu_token",
  "accountId": 1,
  "inboxId": 1,
  "enabled": true
}
```

### Typebot
- Conecte fluxos por webhook ou conector nativo por instância.
- Mensagens recebidas disparam o Typebot automaticamente.
- Respostas do Typebot são enviadas de volta ao contato.

### Configuracao assistida no painel

A aba **Conectores** reduz a configuracao manual. O usuario escolhe a instancia e o painel mostra:

- API key mascarada com botao de copiar.
- URL base, endpoint `send-text` e endpoint `send-media` prontos para copiar.
- Status de prontidao por conector: API key, campos obrigatorios, configuracao salva e webhook criado.
- Passo a passo por n8n, Typebot e Chatwoot.
- Exemplo `curl` atualizado com a instancia selecionada.
- Payload de evento para explicar o formato recebido por n8n, CRM ou backend proprio.
- Criacao de webhook para n8n sem montar JSON manualmente; no Chatwoot, o salvamento usa `/chatwoot/config` para tentar registrar o webhook de retorno no inbox.

Fluxo recomendado:

1. Crie ou selecione uma instancia conectada.
2. Abra **Conectores**.
3. Preencha o card do provedor.
4. Clique em **Salvar e ativar**.
5. Para n8n, clique em **Criar webhook**. Para Chatwoot, salve a configuracao para acionar o auto-registro.
6. Use **Saude da Plataforma** para testar entregas, logs e reenvios.

Campos por provedor:

- n8n: Production URL do node Webhook e token opcional do workflow.
- Typebot: URL base, Public ID e API token.
- Chatwoot: URL, API Access Token, Account ID e Inbox ID. O endpoint `/chatwoot/config` tambem registra o webhook de retorno no inbox quando possivel.

### MCP Server (Model Context Protocol)
Servidor MCP integrado para Claude Desktop / Cursor:
- 17 tools: enviar mensagens, gerenciar grupos, consultar contatos, instâncias
- Resources: conversas, instâncias, mensagens
- Prompts: templates para agente de suporte, campanha, grupos

## Docker / Portainer

O projeto inclui `Dockerfile` e `docker-compose.yml` para stack única.

```bash
docker compose up -d --build
```

Serviço:

- `Wozapi`
- porta `3000`
- volume `wooapi_data`

Arquivos persistidos:

- `/data/database.db`
- `/data/wooapi_bridge.db`
- `/data/uploads`

Use Nginx, Traefik ou Cloudflare Tunnel apontando para a porta `3000`.

## Documentacao da API

- Guia Wozapi: `docs/wooapi-api.md`
- Documentacao publica Wozapi: `/docs/wozapi`
- Collection Postman: `/postman/wooapi.postman_collection.json`

A Wozapi usa `x-api-key` ou `token` para rotas de instancia e `admintoken` para rotas administrativas. Configure `WOOAPI_ADMIN_TOKEN` no ambiente de producao.
