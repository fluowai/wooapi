# Analise SaaS Wooapi

## Objetivo do produto

Wooapi passa a ser uma plataforma SaaS para venda de instancias autonomas de WhatsApp. O dono do sistema opera como Super Admin, cria planos e define cotas. Clientes revendedores recebem uma quantidade de instancias e podem criar clientes finais com subcotas. Clientes finais usam API, webhook ou websocket para integrar Wooapi com ferramentas externas.

## Papeis

- Super Admin: dono da plataforma, cria planos, contas, cotas, pausa/bloqueia contas e acessa suporte por impersonate.
- Revendedor: compra uma cota de instancias, cria clientes filhos e distribui instancias dentro da propria cota.
- Cliente final: conecta numeros WhatsApp e usa API/webhook/websocket para automacoes.

## Core que deve permanecer

- Instancias WhatsApp via WooAPI Core.
- QR Code, conexao, logout e status em tempo real.
- API publica `/api/v1` com autenticao por API key da instancia.
- Webhook por instancia para eventos externos.
- Websocket/socket.io no mesmo servidor para eventos em tempo real.
- Logs de mensagens, conversas e webhooks.
- Super Admin com planos, contas, limites e monitoramento.
- Painel de clientes SaaS para revendedores.
- Integracoes operacionais com n8n, Chatwoot e Typebot via HTTP/webhook.

## Funcionalidades legado

As areas de captacao de leads, campanhas, agentes IA, agenda e kanban foram mantidas no codigo para compatibilidade, mas removidas da navegacao principal. Elas nao sao parte do produto principal Wooapi API-first. Se forem vendidas no futuro, devem virar modulo adicional, nao requisito do core.

## Mudancas implementadas

- Contas agora suportam `parent_account_id`, `account_type`, `instance_quota` e `max_client_accounts`.
- Planos agora suportam cota de clientes filhos.
- A cota de instancias considera instancias proprias e instancias alocadas para clientes filhos.
- Criado endpoint `/api/reseller/overview`.
- Criado endpoint `/api/reseller/clients` para listar, criar e atualizar clientes filhos.
- Painel principal foi reposicionado para SaaS/API.
- Menu principal agora foca em Dashboard, Instancias API, Clientes SaaS, Mensagens, Integracoes e Configuracoes.
- Super Admin permite criar contas como cliente, revendedor ou dono, com cotas de instancias e clientes.

## Deploy Docker/Portainer

O projeto continua preparado para Docker Compose/Portainer usando o servico `wooapi` na porta 3000. O servidor unico entrega frontend, API, websocket e webhooks, sem necessidade de servidor separado para webhook.
