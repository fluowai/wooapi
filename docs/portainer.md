# Wozapi no Portainer

Use `docker-stack.portainer.yml` para subir a Wozapi em Portainer/Swarm com Traefik.

## Plano da stack

1. `Wozapi` publica painel, API, Socket.IO, Wozapi 1.0 e o proxy Wozapi 2.0.
2. `wozapi-v2-core` fica interno na rede da stack e atende somente o proxy 2.0.
3. `redis` fica interno para as filas BullMQ.
4. Workers rodam separados para webhooks, mensagens, monitoramento, alertas, limpeza e Chatwoot.
5. O banco usa Supabase/PostgreSQL externo via `DATABASE_URL`.
6. O Traefik publica o painel nos tres dominios configurados.

## Dominios publicados

Todos estes dominios acessam o mesmo painel:

- `https://painel.wozapi.com.br`
- `https://wozapi.com.br`
- `https://wozapi.consultio.com.br`

`APP_URL` fica configurado como `https://painel.wozapi.com.br`.

## Antes de subir

Confirme estes pontos no servidor/Portainer:

- A imagem `ghcr.io/fluowai/Wozapi:latest` existe e esta acessivel pelo Swarm.
- A rede externa do Traefik existe com o nome `consultio1`.
- Os DNS dos tres dominios apontam para o Traefik.
- O schema/migrations da Wozapi ja foi aplicado no Supabase.

## Servicos

- `Wozapi`
- `wozapi-v2-core`
- `redis`
- `Wozapi-webhook-worker`
- `Wozapi-message-worker`
- `Wozapi-monitor-worker`
- `Wozapi-alert-worker`
- `Wozapi-cleanup-worker`
- `Wozapi-chatwoot-worker`

## Persistencia

- `Wozapi_data`: sessoes WhatsApp 1.0, uploads, backups locais e cache da bridge.
- `Wozapi_redis_data`: persistencia AOF do Redis.
- `wozapi_v2_sessions`: sessoes do Wozapi 2.0.
- `wozapi_v2_media`: midias locais do Wozapi 2.0.

## Wozapi 1.0 e 2.0

Ao criar uma instancia no painel, escolha `Wozapi 1.0` para o core atual ou `Wozapi 2.0` para o novo core.

Na stack, o app usa:

```text
BRIDGE_URL=http://127.0.0.1:3001
WOZAPI_V2_BRIDGE_URL=http://127.0.0.1:3003
WOZAPI_V2_UPSTREAM_URL=http://wozapi-v2-core:3000
BRIDGE_DEVICE_NAME=Wozapi
WOZAPI_V2_DEVICE_NAME=Wozapi2
WOZAPI_V2_BROWSER_NAME=Wozapi2
```

Se quiser proteger o core 2.0 interno com chave, defina `WOZAPI_V2_UPSTREAM_API_KEY` no Portainer. A stack aplica essa mesma chave no core e no proxy.

## Traefik

A stack publica somente o servico `Wozapi` na rede externa `consultio1`.

O Traefik aponta para a porta interna `3000` e usa:

```text
traefik.http.routers.wooapi.rule=Host(`painel.wozapi.com.br`) || Host(`wozapi.com.br`) || Host(`wozapi.consultio.com.br`)
```

## Validacao

Depois do deploy:

```bash
curl https://painel.wozapi.com.br/health
curl https://wozapi.com.br/health
curl https://wozapi.consultio.com.br/health
```

Se o healthcheck vier degradado, confira no Portainer os logs de `Wozapi`, Redis, conexao Supabase e bridge WhatsApp.
