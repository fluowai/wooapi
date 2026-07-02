# Termos de Uso da Wozapi

## Natureza do Produto

A Wozapi e uma plataforma de automacao para WhatsApp baseada em sessoes conectadas pelo cliente. Ela nao substitui contratos diretos, aprovacoes, templates ou garantias oferecidas por canais oficiais do provedor.

## Recomendacao de Conta

Recomendamos usar WhatsApp Business App em vez de WhatsApp comum. Contas comuns podem apresentar mais desconexoes, limites, inconsistencias e risco operacional.

## Recursos Nao Oferecidos

Botoes nativos oficiais nao fazem parte do produto vendavel desta versao. Quando necessario, use texto, links, listas textuais, midias e webhooks.

## Risco de Uso

O WhatsApp pode alterar protocolos, limitar contas, desconectar sessoes ou bloquear numeros. O cliente e responsavel por seguir politicas de opt-in, LGPD, consentimento, descadastro e boas praticas de envio.

## Uso Proibido

E proibido usar a Wozapi para spam, fraude, phishing, conteudo ilegal, scraping abusivo, disparos sem consentimento ou qualquer pratica que viole leis, direitos de terceiros ou politicas do WhatsApp.

## Campanhas e Limites

Campanhas devem usar delays, limites por instancia e listas com consentimento. A Wozapi pode pausar, limitar ou bloquear contas que gerem abuso, falhas excessivas ou risco de reputacao.

## Suporte e Disponibilidade

Disponibilidade depende de infraestrutura do cliente, Redis, banco, rede, estado da conta WhatsApp e conectividade com servidores do WhatsApp. Em producao, use backups, monitoramento e Redis/BullMQ.

## Dados e Backups

O cliente deve manter backups do banco principal e dos arquivos de sessao/midia. Em PostgreSQL/Supabase, o backup do banco deve ser feito pelo provedor ou por `pg_dump`.
