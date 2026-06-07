# WooAPI no Portainer

Use `docker-stack.portainer.yml` para subir a WooAPI em Portainer/Swarm com Traefik.

## Plano da stack

1. `wooapi` publica painel, API, Socket.IO e bridge WhatsApp embutida.
2. `redis` fica interno para as filas BullMQ.
3. Workers rodam separados para webhooks, mensagens, monitoramento, alertas, limpeza e Chatwoot.
4. O banco usa Supabase/PostgreSQL externo via `DATABASE_URL`.
5. O Traefik publica o painel nos tres dominios configurados.

## Dominios publicados

Todos estes dominios acessam o mesmo painel:

- `https://painel.wooapi.com.br`
- `https://wooapi.com.br`
- `https://wooapi.consultio.com.br`

`APP_URL` fica configurado como `https://painel.wooapi.com.br`.

## Antes de subir

Confirme estes pontos no servidor/Portainer:

- A imagem `ghcr.io/woosolutionsc/wasenderbr:latest` existe e esta acessivel pelo Swarm.
- A rede externa do Traefik existe com o nome `consultio1`.
- Os DNS dos tres dominios apontam para o Traefik.
- O schema/migrations da WooAPI ja foi aplicado no Supabase.

## Servicos

- `wooapi`
- `redis`
- `wooapi-webhook-worker`
- `wooapi-message-worker`
- `wooapi-monitor-worker`
- `wooapi-alert-worker`
- `wooapi-cleanup-worker`
- `wooapi-chatwoot-worker`

## Persistencia

- `wooapi_data`: sessoes WhatsApp, uploads, backups locais e cache da bridge.
- `wooapi_redis_data`: persistencia AOF do Redis.

## Traefik

A stack publica somente o servico `wooapi` na rede externa `consultio1`.

O Traefik aponta para a porta interna `3000` e usa:

```text
traefik.http.routers.wooapi.rule=Host(`painel.wooapi.com.br`) || Host(`wooapi.com.br`) || Host(`wooapi.consultio.com.br`)
```

## Validacao

Depois do deploy:

```bash
curl https://painel.wooapi.com.br/health
curl https://wooapi.com.br/health
curl https://wooapi.consultio.com.br/health
```

Se o healthcheck vier degradado, confira no Portainer os logs de `wooapi`, Redis, conexao Supabase e bridge WhatsApp.
