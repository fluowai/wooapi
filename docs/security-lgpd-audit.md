# Auditoria de Seguranca e LGPD - Wozapi

Data da analise: 2026-06-07

## Escopo

Analise local do repositorio, configuracoes, dependencias, rotas Express, frontend, workers, Docker/Portainer, bancos SQLite locais e artefatos operacionais. Foram executados testes controlados em `http://127.0.0.1:3000`, sem exploracao externa e sem exfiltrar dados reais.

## Sumario Executivo

O projeto tem uma base funcional com separacao por conta, tokens de instancia, HMAC para webhooks, rate limit basico, logs operacionais e rotinas de limpeza. Porem, no estado atual, ele nao deve ser tratado como pronto para producao sem correcoes imediatas.

Riscos principais:

1. Credenciais reais em texto claro em arquivos locais de deploy e ambiente.
2. Dados pessoais e segredos operacionais persistidos sem criptografia em SQLite, logs, backups e banco da bridge WhatsApp.
3. CORS amplo e ausencia de headers HTTP defensivos na aplicacao principal.
4. Tokens/API keys aceitos em query string, com risco de vazamento por logs, historico e referer.
5. Dependencias com vulnerabilidades conhecidas, incluindo uma critica em `protobufjs`.
6. Lacunas LGPD: falta politica de privacidade completa, registro de base legal/consentimento por lead, exportacao de dados do titular, anonimizaçao e retencao granular.

## Achados Criticos

### C1. Segredos reais em arquivos do projeto

Evidencias:

- `.env` contem valores reais para `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `WEBHOOK_SECRET`, `BRIDGE_TOKEN`, `REDIS_PASSWORD` e `REDIS_URL`.
- `docker-stack.portainer.yml` contem os mesmos tipos de segredos diretamente no YAML.
- `.env` nao esta rastreado pelo Git no momento, mas esta presente no workspace. O stack de Portainer tambem nao apareceu como rastreado no Git local, mas e um artefato pronto para vazamento por backup, zip, print, compartilhamento ou deploy.

Impacto:

- Acesso ao banco/Supabase, assinatura de tokens, controle administrativo, ponte interna e Redis podem ser comprometidos.
- Se qualquer um desses arquivos foi compartilhado, enviado a servidor, printado ou commitado em outro historico, considere incidente de segredo.

Acao imediata:

- Rotacionar todos os segredos expostos.
- Remover valores reais de `docker-stack.portainer.yml`; usar secrets do Docker/Portainer, variaveis externas ou vault.
- Invalidar credenciais antigas no Supabase, Redis, JWT/webhook/admin/bridge e qualquer token de instancia possivelmente exposto.

### C2. Banco local e bridge armazenam dados pessoais e chaves sensiveis

Inventario confirmado localmente:

- `database.db`: 1 conta, 1 usuario, 1 instancia, 3 conversas e 22 mensagens.
- `data/wooapi_bridge.db`: chaves de sessao, identity keys, pre-keys, message secrets, contatos e JIDs do WhatsApp.
- `go-bridge/media-cache`: arquivos `.pb` com cache de midia/eventos.

Impacto:

- Vazamento do workspace ou de backup local pode expor mensagens, telefones, JIDs, perfis, chaves de sessao WhatsApp e dados de conta.

Acao imediata:

- Tratar `*.db`, `*.db-wal`, `*.db-shm`, `media-cache`, `logs` e `backups` como dados sensiveis.
- Criptografar volumes em producao e backups.
- Definir procedimento de descarte seguro e retencao.
- Evitar copiar bancos reais para repositorios, suporte ou ambientes de teste.

## Achados Altos

### A1. CORS permissivo e configuracao insegura por padrao

Evidencias:

- `server.ts` usa `CORS_ORIGIN || "*"` e `app.use(cors({ origin: CORS_ORIGIN }))`.
- `.env.example` e `docker-compose.yml` mantem `CORS_ORIGIN="*"`/fallback `*`.
- Teste local retornou `Access-Control-Allow-Origin: *` em rotas publicas e protegidas.

Impacto:

- Em conjunto com tokens expostos, XSS ou navegadores em ambientes internos, amplia superficie de abuso cross-origin.

Correcao:

- Trocar para allowlist real por ambiente.
- Rejeitar origens desconhecidas.
- Evitar passar string com multiplas origens separadas por virgula diretamente ao `cors`; parsear para array/lista e validar dinamicamente.

### A2. Headers HTTP defensivos ausentes

Teste local na pagina principal:

- Presente: `X-Powered-By: Express`.
- Ausentes na resposta principal: CSP, `X-Frame-Options`/`frame-ancestors`, HSTS, `Referrer-Policy`, `Permissions-Policy`.

Impacto:

- Maior risco de clickjacking, exposicao de tecnologia, vazamento por referer e danos em caso de XSS.

Correcao:

- Usar `helmet`.
- Desabilitar `x-powered-by`.
- Definir CSP compatível com Vite/React em producao.
- Habilitar HSTS apenas sob HTTPS definitivo.

### A3. Tokens aceitos em query string

Evidencias:

- `server.ts` aceita `req.query.token` e `req.query.apiKey` em endpoints de instancia/API.
- `src/rate-limit.ts` inclui `req.query.token` no rate limit.

Impacto:

- Tokens em URL aparecem em logs, historico do navegador, proxy, referer e ferramentas de monitoramento.

Correcao:

- Descontinuar token por query string.
- Aceitar somente `Authorization: Bearer` ou `x-api-key`.
- Redigir tokens em logs e rejeitar `?token=` com erro explicito.

### A4. Upload publico sem validacao forte

Evidencias:

- `multer({ dest: uploadDir })`.
- `/uploads` servido por `express.static(uploadDir)`.
- Nao ha allowlist de MIME/extensao, limite especifico de tamanho por arquivo, antivirus/sandbox ou politica de expiracao.

Impacto:

- Risco de armazenamento de conteudo indevido, malware, abuso de disco, exposicao publica e LGPD por midias pessoais.

Correcao:

- Definir tamanho maximo, MIME/extensoes permitidas, nomes aleatorios sem extensao perigosa, scan, quota por conta e expiracao.
- Servir uploads por rota autenticada quando o arquivo for privado.

### A5. Dependencias vulneraveis

`npm audit --omit=dev --json` encontrou 15 vulnerabilidades:

- Critica: `protobufjs`.
- Altas: `vite`, `path-to-regexp`, `picomatch`, `socket.io-parser`.
- Moderadas: `express/body-parser/qs/ws/postcss` e outras transitivas.

Correcao:

- Rodar atualizacao controlada (`npm audit fix` ou upgrades direcionados).
- Reexecutar build, lint e smoke tests.
- Priorizar `protobufjs`, `socket.io`, `express`, `vite` e dependencias transitivas que entram no runtime.

## Achados Medios

### M1. Senhas legadas podem ser aceitas em texto puro

Evidencia:

- `verifyPassword` retorna `password === stored` quando o hash nao comeca com `pbkdf2$`.

Impacto:

- Compatibilidade com legado pode manter senhas em texto claro se existirem registros antigos.

Correcao:

- Forcar reset/migracao de senhas legadas.
- Remover comparacao direta apos periodo curto.
- Considerar Argon2id/bcrypt com parametros modernos.

### M2. JWT proprio sem `exp` por padrao

Evidencia:

- `signToken` assina payload arbitrario e os logins atuais nao definem `exp`.

Impacto:

- Tokens de painel podem durar indefinidamente ate rotacao do segredo.

Correcao:

- Adicionar expiracao curta, refresh token rotacionavel e revogacao por usuario.
- Incluir `iat`, `aud`, `iss` e versao de sessao.

### M3. Token do painel armazenado em `localStorage`

Evidencia:

- `src/App.tsx` grava `wooapi_auth` em `localStorage`.

Impacto:

- Qualquer XSS permite roubo de token.

Correcao:

- Preferir cookie `HttpOnly`, `Secure`, `SameSite=Lax/Strict`.
- Se mantiver SPA bearer token, endurecer CSP e reduzir TTL.

### M4. Logs retêm payloads completos de webhook

Evidencias:

- `webhook_delivery_logs` guarda `request_payload` e `response_body`.
- Worker registra corpo completo do evento.

Impacto LGPD:

- Payloads podem conter mensagens, telefone, JID, nome, midia e respostas de terceiros.

Correcao:

- Redigir PII por padrao nos logs.
- Guardar payload completo somente em modo diagnostico temporario e por conta.
- Definir TTL menor para payloads sensiveis.

### M5. Falta RLS/policies no Supabase

Evidencia:

- Migrations nao apresentam `ENABLE ROW LEVEL SECURITY` nem `CREATE POLICY`.
- Documentacao orienta uso pelo backend com credenciais de servidor.

Impacto:

- Modelo e aceitavel se o banco nunca for acessado diretamente pelo frontend. Se chaves Supabase vazarem, RLS ausente aumenta impacto.

Correcao:

- Mesmo usando backend, adicionar RLS para tabelas multi-tenant ou restringir grants.
- Nunca expor service role ou `DATABASE_URL`.

## LGPD

Dados pessoais tratados:

- Conta/usuario: nome, email, telefone, documento, status de assinatura.
- Leads: nome, telefone, endereco, nicho, tags, campos customizados.
- WhatsApp: telefone, JID, nome de perfil, foto de perfil, mensagens, midias, grupos, metadados e recibos.
- Operacional: IP, user-agent, logs de API, webhooks, erros, tickets de suporte.
- Segredos do cliente: API keys de instancia, webhooks, credenciais de LLM/integracoes.

Bases legais provaveis:

- Execucao de contrato para operacao do painel/API.
- Legitimo interesse para seguranca, logs e antifraude, com minimizacao.
- Consentimento/opt-in para campanhas e mensagens ativas.
- Cumprimento de obrigacao legal/regulatoria quando aplicavel.

Lacunas:

- Nao ha politica de privacidade completa no repositorio; ha apenas termos de uso com mencao a LGPD/consentimento.
- Nao ha registro estruturado de consentimento/opt-in por lead/destinatario.
- Nao ha endpoint de exportacao dos dados do titular.
- Nao ha fluxo de anonimizaçao ou exclusao granular por titular final.
- Retencao de mensagens e midias nao esta claramente parametrizada por conta/finalidade.
- Backups e media-cache precisam entrar no procedimento de eliminacao.

Recomendacoes LGPD:

1. Criar politica de privacidade com controlador/operador, encarregado, finalidades, bases legais, compartilhamentos, retencao e direitos do titular.
2. Adicionar campos de consentimento em leads/campaign recipients: origem, data/hora, prova, canal, finalidade, opt-out.
3. Criar endpoints admin/conta para exportar, anonimizar e excluir dados de titular.
4. Separar retencao de logs tecnicos, mensagens, midias, webhooks e backups.
5. Redigir dados sensiveis em logs e suporte.
6. Documentar subprocessadores: Supabase/Postgres, Redis, Stripe, WhatsApp, Chatwoot, Typebot, n8n, provedor de email e hospedagem.
7. Criar procedimento de incidente: deteccao, contencao, rotacao de segredos, avaliacao de risco, comunicacao a ANPD/titulares quando aplicavel.

## Testes Executados

Comandos/validacoes:

- `npm run lint`: aprovado.
- `npm audit --omit=dev --json`: 15 vulnerabilidades; 1 critica, 4 altas, 10 moderadas.
- Inventario SQLite sem dump de valores: confirmou dados pessoais e chaves/sessoes locais.
- `GET /health`: 200, informou Redis indisponivel e `production_ready=false`.
- `GET /api/admin/accounts` sem token: 401.
- `GET /api/v1/instances` sem token: 401.
- `OPTIONS /api/auth/login` com origem externa: 204 com `Access-Control-Allow-Origin: *`.
- `POST /api/upload` sem token: 401.
- Tentativa de traversal `/uploads/../.env`: nao retornou `.env`; caiu no SPA.

## Plano de Remediacao Priorizado

### 0-24 horas

- Rotacionar todos os segredos presentes em `.env` e `docker-stack.portainer.yml`.
- Remover segredos reais dos YAMLs e mover para secret manager/Portainer secrets.
- Confirmar que nenhum artefato com segredos foi publicado em Git remoto, imagem Docker, chat, zip ou backup compartilhado.
- Bloquear acesso publico a backups, bancos SQLite, logs e media-cache.

### 1-3 dias

- Corrigir CORS com allowlist real.
- Adicionar `helmet`, CSP, HSTS, `Referrer-Policy`, `Permissions-Policy` e remover `X-Powered-By`.
- Remover tokens por query string.
- Atualizar dependencias vulneraveis.
- Limitar e validar upload.
- Redigir payloads sensiveis em logs.

### 1-2 semanas

- Implementar expiracao/revogacao de sessoes.
- Migrar tokens do painel para cookie `HttpOnly` ou reduzir TTL com CSP forte.
- Criptografar segredos de cliente em banco (`api_key`, webhook secrets, LLM credentials).
- Definir RLS/grants no Supabase e revisar menor privilegio.
- Criar endpoints de exportacao/exclusao/anonimizacao LGPD.

### 30 dias

- Formalizar DPIA/RIPD simplificado.
- Criar politica de privacidade e DPA/termos de operador.
- Implementar registro de consentimento/opt-out.
- Rodar DAST autenticado em staging e teste de restauracao de backup.
- Criar rotina mensal de `npm audit`, secret scan e revisao de logs.

## Conclusao

Estado atual: nao aprovado para producao sem correcoes criticas. A arquitetura tem bons blocos de controle, mas os segredos expostos, armazenamento sensivel local, CORS permissivo e lacunas LGPD elevam o risco. A primeira resposta deve ser rotacao de credenciais e hardening de configuracao; em seguida, reduzir exposicao de dados pessoais e formalizar governanca LGPD.

## Correcoes Aplicadas em 2026-06-07

- Mantido SQLite/bridge como armazenamento operacional, mas reforcado `.gitignore` para impedir exposicao acidental de `data/`, `uploads/`, logs, WAL/SHM, bancos locais, backups e cache de midia.
- Removidos segredos reais de `docker-stack.portainer.yml`; o stack agora espera variaveis externas no Portainer/secret manager.
- CORS deixou de usar `*` como padrao em exemplos e passou a validar allowlist no servidor.
- Adicionados headers defensivos: CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` e HSTS quando `APP_URL` for HTTPS.
- Removido `X-Powered-By` do Express.
- Tokens/API keys deixaram de ser aceitos por query string nas rotas HTTP; continuam aceitos por headers.
- Upload passou a ter limite configuravel, allowlist de MIME/extensao e erro JSON.
- Tokens de sessao passaram a receber expiracao padrao configuravel.
- Senhas legadas em texto puro deixaram de ser aceitas no login.
- Logs de entrega de webhook passaram a persistir payload redigido, mantendo entrega completa apenas ao destino configurado.
- `npm audit fix` aplicado; `npm audit --omit=dev` passou com 0 vulnerabilidades.
- Verificacoes executadas: `npm run lint`, `npm run build` e `npm audit --omit=dev`.

## Correcoes Aplicadas em 2026-06-09

### LGPD - Endpoints de Dados do Titular

Implementados no `server.ts`:

- `POST /api/data/export` — exportacao completa dos dados do titular (DSAR), com registro em `data_subject_requests`
- `POST /api/data/anonymize` — anonimizacao granular por escopo: `account`, `messages`, `leads`, `conversations`, `all`
- `POST /api/data/consent` — registro e revogacao de consentimento com armazenamento de IP e user-agent
- `GET /api/data/consent/:userId` — consulta de registros de consentimento
- `GET /api/data/requests` — listagem do historico de solicitacoes do titular
- `GET /privacy` — politica de privacidade completa servida via `docs/privacy.md`

Tabelas criadas na migrate (`server.ts` ~1009-1011):

- `data_consent` — registro de consentimentos LGPD
- `data_retention_policies` — politicas de retencao por tipo de dado
- `data_subject_requests` — solicitacoes de titulares (export/anonimizacao)

### Retention Policy Scheduler

Implementado scheduler a cada 1h que aplica automaticamente as politicas de `data_retention_policies`:
- `messages`: deleta mensagens antigas
- `logs`: limpa `message_logs` e `connection_logs`
- `webhooks`: limpa `webhook_events` e `webhook_delivery_logs`
- `consent`: deleta registros de consentimento revogados fora do prazo

### MCP Server (Model Context Protocol)

Novo pacote `mcp-server/` para integracao com assistentes IA via protocolo MCP:

- 17 ferramentas organizadas em 4 categorias: mensagens, grupos, contatos, instancias
- 3 resources (`Wozapi://conversations`, `Wozapi://instances`, `Wozapi://messages`)
- 4 prompts (`customer_support_agent`, `broadcast_campaign`, `group_management`, `contact_research`)
- Transporte stdio, compativel com Claude Desktop e Cursor
- URI scheme `Wozapi://` para resources

### Cobertura de auditoria atualizada

| Requisito | Status |
|-----------|--------|
| Politica de privacidade | ✅ Implementado (`docs/privacy.md` + `GET /privacy`) |
| Registro de consentimento | ✅ Implementado (`POST /api/data/consent`) |
| Exportacao de dados do titular | ✅ Implementado (`POST /api/data/export`) |
| Anonimizacao/exclusao | ✅ Implementado (`POST /api/data/anonymize`) |
| Retencao parametrizada | ✅ Implementado (`data_retention_policies` + scheduler) |
| Consentimento por lead | ⏳ Pendente (frontend + campanhas) |
| Token do painel em cookie HttpOnly | ⏳ Pendente |

Pendencias que continuam relevantes:

- Rotacionar credenciais que ja ficaram expostas anteriormente.
- Avaliar migracao do token do painel de `localStorage` para cookie `HttpOnly`.
- Consentimento por lead no frontend e campanhas.
- Planejar persistencia segura do banco da bridge WhatsApp em volume/backup criptografado, fora do repositorio.
