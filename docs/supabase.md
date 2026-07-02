# Wozapi com Supabase

## 1. Criar o banco

No painel do Supabase, abra **SQL Editor** e execute:

```sql
-- conteúdo de migrations/20260525_supabase_saas_schema.sql
```

Esse schema cria a base SaaS do Wozapi:

- planos
- contas
- usuários
- instâncias
- conversas e mensagens
- eventos de webhook
- logs de API, conexão, mensagens e auditoria
- integrações n8n, Chatwoot e Typebot
- sessões de suporte e uso

## 2. Configurar conexão no Wozapi

No Supabase, copie a connection string PostgreSQL em:

**Project Settings > Database > Connection string**

Depois configure no ambiente do Wozapi:

```env
DATABASE_URL=postgresql://postgres:SENHA@HOST:5432/postgres
```

Para produção, use a connection string recomendada pelo Supabase para servidores.

## 3. Segurança

Use o banco pelo backend do Wozapi, com credenciais de servidor. Não exponha `DATABASE_URL`, `service_role`, JWT secret ou chaves internas no frontend.

## 4. Cotas

O schema inclui a função:

```sql
select * from get_account_quota_usage(1);
```

Ela retorna:

- cota total da conta
- instâncias próprias usadas
- cotas alocadas para clientes filhos
- instâncias usadas pelos filhos
- disponibilidade para alocar
- disponibilidade para criar instâncias próprias

## 5. Próximo passo no código

O schema já está pronto para Supabase/PostgreSQL. O próximo passo técnico é trocar a camada atual baseada em SQLite por uma camada de persistência que escolha:

- SQLite quando `DATABASE_URL` estiver vazio
- PostgreSQL/Supabase quando `DATABASE_URL` estiver preenchido

Isso deve ser feito em uma camada central de banco para evitar duplicar SQL pelo backend.
