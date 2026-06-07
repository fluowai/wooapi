# WooAPI

Sua infraestrutura própria para vender e gerenciar instâncias WhatsApp com API, Webhook e WebSocket.

## Visão Geral

O WooAPI é uma plataforma SaaS API-first para operação, venda e revenda de instâncias WhatsApp autônomas.

O servidor único entrega:

- painel web
- API pública `/api/v1`
- WebSocket / Socket.IO
- webhooks por instância
- autenticação e contas SaaS
- integração com WooAPI Core

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

Sem `DATABASE_URL`, o WooAPI usa SQLite local. Com `DATABASE_URL`, a implantação fica preparada para PostgreSQL em produção.

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

- n8n: receba eventos via webhook e responda com `/send-text`.
- Typebot: conecte fluxos por webhook ou conector nativo por instância.
- Chatwoot: use o webhook operacional para mensagens `outgoing`.

## Docker / Portainer

O projeto inclui `Dockerfile` e `docker-compose.yml` para stack única.

```bash
docker compose up -d --build
```

Serviço:

- `wooapi`
- porta `3000`
- volume `wooapi_data`

Arquivos persistidos:

- `/data/database.db`
- `/data/wooapi_bridge.db`
- `/data/uploads`

Use Nginx, Traefik ou Cloudflare Tunnel apontando para a porta `3000`.

## Documentacao da API

- Guia WooAPI: `docs/wooapi-api.md`
- Documentacao publica WooAPI: `/docs/wooapi`
- Collection Postman: `/postman/wooapi.postman_collection.json`

A WooAPI usa `x-api-key` ou `token` para rotas de instancia e `admintoken` para rotas administrativas. Configure `WOOAPI_ADMIN_TOKEN` no ambiente de producao.
