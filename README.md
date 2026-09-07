# Viora — Gerenciador de tarefas com dependências

Aplicação acadêmica em **HTML, CSS e JavaScript puro** com **Supabase Auth + PostgreSQL**, projetada para cumprir os quatro critérios do SENAI e manter autenticação/dados separados por conta.

## Recursos implementados

- cadastro, confirmação de e-mail, login, logout e recuperação de senha;
- sessão do SDK persistida em `sessionStorage` (não em `localStorage`);
- mensagens genéricas no login para reduzir enumeração de usuários;
- suporte a Cloudflare Turnstile nos fluxos de login, cadastro e recuperação;
- autenticação em duas etapas TOTP (MFA) com desafio no login;
- RLS por usuário em todas as tabelas de dados;
- política RLS restritiva que exige AAL2 quando a conta possui MFA verificado;
- frontend aceita somente chave `sb_publishable_...`;
- nenhuma `service_role`/`sb_secret_...` no navegador;
- exclusão de conta via Supabase Edge Function usando `@supabase/server`, com chave secreta somente no ambiente da função;
- PostgreSQL relacional: projetos, tarefas, dependências, cronômetros e preferências;
- tarefas-pai/subtarefas e conclusão calculada;
- dependências entre tarefas executáveis;
- anti-loop em qualquer profundidade no JavaScript **e também no PostgreSQL**;
- bloqueio/desbloqueio automático;
- caminho crítico e Gantt sem biblioteca de gráficos;
- prioridade calculada;
- parser real de `E`, `OU` e parênteses;
- cronômetro opcional separado da estimativa;
- importação/exportação JSON validada antes de entrar no estado.

---

# O que você precisa configurar

## 1. Criar um projeto no Supabase

1. Entre no Supabase e crie um projeto.
2. Guarde o **Project URL**.
3. Em **Project Settings / API Keys**, copie a chave moderna **Publishable** (`sb_publishable_...`).
4. Não copie `sb_secret_...` nem `service_role` para o frontend.

O arquivo `js/supabase-client.js` recusa propositalmente chaves que não sejam `sb_publishable_...`.

## 2. Criar o banco relacional e as políticas RLS

1. No Supabase, abra **SQL Editor**.
2. Abra o arquivo local `supabase/schema.sql`.
3. Copie o arquivo inteiro para o SQL Editor.
4. Execute uma vez.

Ele cria:

- `profiles`;
- `projects`;
- `tasks`;
- `task_dependencies`;
- `timer_sessions`;
- `user_preferences`;
- triggers de integridade;
- detecção de ciclos no PostgreSQL;
- RLS de propriedade;
- RLS restritiva para MFA opt-in;
- a RPC transacional `replace_user_state`.

> Se você já usou a versão antiga baseada em `app_states`, exporte seus dados antes. A nova versão não usa essa tabela.

## 3. Conectar o frontend

Abra `js/supabase-config.js`:

```js
export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_COLE_AQUI';
export const TURNSTILE_SITE_KEY = '';
```

Preencha URL + chave pública.

## 4. Configurar autenticação por e-mail

No Dashboard do Supabase:

1. Vá para **Authentication**.
2. Mantenha **Email + Password** habilitado.
3. Mantenha **Confirm Email** habilitado.
4. Configure o mínimo de senha em **12 caracteres**.
5. Exija maiúscula, minúscula, número e símbolo.
6. Se seu plano oferecer proteção de senhas vazadas, habilite-a.
7. Habilite a opção de exigir a senha atual/reauthentication para mudanças de senha conforme sua política de segurança.

### URLs de desenvolvimento

Em **Authentication > URL Configuration**:

- Site URL: `http://localhost:5500`
- Redirect URL: `http://localhost:5500/**`

Quando publicar o site, adicione também a URL HTTPS real.

## 5. Ativar Cloudflare Turnstile

O código já está preparado, mas ele só aparece quando você configurar uma Site Key.

### Cloudflare

1. Crie um widget Turnstile para seu domínio.
2. Copie a **Site Key** (pública).
3. Copie a **Secret Key** (privada).

### Supabase

1. Vá para **Authentication > Settings > Bot and Abuse Protection**.
2. Ative CAPTCHA.
3. Selecione Cloudflare Turnstile.
4. Cole **somente a Secret Key** no Dashboard do Supabase.

### Frontend

No `js/supabase-config.js`, coloque apenas a Site Key:

```js
export const TURNSTILE_SITE_KEY = 'SUA_SITE_KEY_PUBLICA';
```

A Secret Key do Turnstile nunca entra no HTML/JS.

## 6. MFA / 2FA

O código já implementa TOTP.

No Dashboard, confirme que a verificação MFA/TOTP não está desabilitada.

Depois, dentro da Viora:

1. Entre na conta.
2. Abra **Conta e segurança**.
3. Clique em **Ativar 2FA**.
4. Escaneie o QR Code no aplicativo autenticador.
5. Digite o código de 6 dígitos.

Depois de verificado, novos logins param na tela do segundo fator antes de carregar dados.

Além disso, o PostgreSQL tem uma política restritiva: se a conta possuir fator MFA verificado, as tabelas só aceitam sessão `aal2`.

## 7. Implantar a Edge Function de exclusão da conta

A exclusão de `auth.users` é administrativa. Por isso **não existe chave administrativa no frontend**.

O código da função está em:

`supabase/functions/delete-account/index.ts`

### Com Supabase CLI

No terminal, na pasta do projeto:

```bash
supabase login
supabase link --project-ref SEU_PROJECT_REF
supabase functions deploy delete-account
```

Opcional, mas recomendado: limite as origens que podem chamar a função:

```bash
supabase secrets set TASKFLOW_ALLOWED_ORIGINS=http://localhost:5500,https://seu-dominio.com
```

A Edge Function usa o `@supabase/server`, que lê automaticamente `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS` e o JWKS provisionados pelo Supabase. **Nenhuma chave secreta deve ser copiada para o frontend.**

Quando o usuário confirma a exclusão:

1. a função valida a sessão;
2. exige AAL2 se a conta tiver MFA;
3. remove os dados da aplicação;
4. remove permanentemente a identidade do Supabase Auth após a confirmação explícita.

## 8. Rodar localmente

### Windows

Extraia a pasta e execute:

`start.bat`

Depois abra:

`http://localhost:5500`

### macOS/Linux

```bash
./run.sh
```

ou:

```bash
python3 -m http.server 5500
```

---

# Arquitetura dos dados

O frontend ainda trabalha em memória com um objeto simples, porque isso facilita os algoritmos acadêmicos:

```json
{
  "schemaVersion": 3,
  "projects": [],
  "tasks": [],
  "timerSessions": [],
  "preferences": {}
}
```

Mas a persistência real é relacional:

```text
auth.users
   │
   ├── profiles
   ├── projects
   │     └── tasks
   │           ├── task_dependencies
   │           └── timer_sessions
   └── user_preferences
```

`db.js` converte as tabelas para o formato em memória ao carregar. Ao salvar, chama a RPC `replace_user_state`, que grava o snapshot em uma única transação PostgreSQL.

## Dados derivados que NÃO são persistidos

São recalculados pelo JavaScript:

- bloqueio;
- prioridade;
- progresso;
- esforço;
- duração estrutural;
- início/fim mais cedo;
- folga;
- caminho crítico;
- quantidade de tarefas desbloqueadas.

---

# Segurança

## Sessão

O frontend usa o SDK oficial `supabase-js` e não cria/decodifica JWT manualmente.

A sessão é configurada com:

```js
storage: window.sessionStorage
```

Isso reduz a persistência do token após fechar a sessão do navegador, mas **não transforma a sessão em HttpOnly**. Em uma aplicação 100% client-side, proteção contra XSS continua essencial.

## XSS

- CSP bloqueia scripts inline;
- dados importados são validados;
- IDs precisam ser UUID válidos;
- strings possuem limites;
- os controles sensíveis são montados com DOM API/`textContent`;
- templates restantes escapam conteúdo de usuário antes de usar HTML;
- não existe `eval()` nem `new Function()`.

## RLS

RLS é a barreira real de autorização. Mesmo alterando JavaScript pelo DevTools, uma conta não consegue consultar/alterar/deletar linhas pertencentes a outra.

## Exclusão e privacidade

A aplicação coleta apenas:

- e-mail no Supabase Auth;
- nome de exibição;
- dados necessários aos projetos/tarefas;
- sessões de cronômetro/preferências.

Não coleta CPF, endereço, telefone, geolocalização ou outros campos que o produto não precisa.

---

# Critérios do SENAI

## 1. Anti-loop — 35%

O `engine.js` verifica o caminho antes de adicionar a dependência. O PostgreSQL repete a validação em trigger para defesa em profundidade.

## 2. Caminho crítico / Gantt — 25%

- duas tarefas independentes de 5h → duração estrutural de 5h;
- Tarefa 2 dependendo da Tarefa 1 → 10h.

## 3. Parser E / OU — 25%

Exemplo literal:

```text
status:pendente E prioridade:alta
```

A entrada é tokenizada, transformada em árvore lógica e avaliada campo a campo.

## 4. UX de bloqueio — 15%

Tarefas bloqueadas possuem:

- aparência acinzentada;
- cadeado;
- `cursor: not-allowed`;
- controles desabilitados;
- motivo textual do bloqueio.

## Testes

```bash
node tests.mjs
```

Esperado:

```text
Todos os testes passaram.
```
