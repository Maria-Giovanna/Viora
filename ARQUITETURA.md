# Arquitetura — Viora v3

## Stack

- HTML sem framework;
- CSS próprio;
- JavaScript ES Modules;
- `@supabase/supabase-js` fixado em versão específica;
- Supabase Auth;
- PostgreSQL;
- Supabase Edge Function apenas para a operação administrativa de excluir conta.

## Camadas

### Interface — `index.html` + `styles.css`

Renderização, formulários, acessibilidade, estados bloqueados, Gantt e fluxos de autenticação.

### Domínio — `engine.js`

- hierarquia pai/filho;
- DFS/BFS;
- anti-loop;
- disponibilidade;
- caminho crítico;
- folga;
- prioridade;
- recomendação da tela Agora.

### Parser — `parser.js`

Tokenizer + parser recursivo + árvore lógica para `E`, `OU` e parênteses.

### Cronômetro — `timer.js`

Tempo real separado do tempo estimado.

### Autenticação — `auth.js`

Somente APIs oficiais do Supabase Auth:

- cadastro;
- login;
- recuperação;
- senha;
- MFA/TOTP;
- Edge Function de exclusão.

### CAPTCHA — `captcha.js`

Integração opcional com Cloudflare Turnstile. A Site Key é pública; a Secret Key fica apenas no Dashboard do Supabase.

### Persistência — `db.js`

Converte entre o modelo em memória e tabelas PostgreSQL.

O salvamento usa `replace_user_state(jsonb)`: uma RPC transacional. Isso mantém os algoritmos simples no frontend sem voltar ao antigo JSONB monolítico como armazenamento real.

## PostgreSQL

### `profiles`

Nome de exibição, ligado a `auth.users`.

### `projects`

Projetos pertencentes a um usuário.

### `tasks`

Tarefas/agrupadores. `parent_id` forma a árvore de decomposição.

### `task_dependencies`

Grafo direcionado entre tarefas executáveis.

### `timer_sessions`

Sessões históricas do cronômetro.

### `user_preferences`

Tempo disponível, projeto ativo e estado do cronômetro ativo.

## Defesa em profundidade

### Camada 1 — JavaScript

Valida antes de mudar a interface:

- dependências inexistentes;
- dependências entre projetos;
- dependência de agrupadores;
- ciclos;
- campos/tamanhos.

### Camada 2 — importação

`sanitizeDatabase()` exige UUID, datas/tempos válidos, limites de tamanho, referências existentes e grafo acíclico.

### Camada 3 — PostgreSQL

Triggers verificam:

- projeto da mesma conta;
- pai da mesma conta/projeto;
- dependências da mesma conta/projeto;
- dependências apenas entre folhas;
- ciclos de dependência;
- timer/preferências apontando apenas para dados do dono.

### Camada 4 — RLS

Todas as tabelas são filtradas por `auth.uid()`.

Se o usuário possui MFA verificado, uma segunda policy `AS RESTRICTIVE` exige `aal2`.

### Camada 5 — operação administrativa

A `chave secreta administrativa` só aparece na variável de ambiente da Edge Function `delete-account`. Nunca é enviada ao navegador.

## Sessão

O SDK persiste a sessão em `sessionStorage` em vez de `localStorage`.

Essa escolha reduz a persistência após fechar o navegador, mas uma SPA client-side não possui cookie HttpOnly. Por isso CSP, validação e prevenção de XSS são parte crítica do modelo.

## XSS

A aplicação evita usar dados crus do Supabase/JSON diretamente em HTML:

- IDs são UUIDs;
- importação é validada;
- conteúdo textual é escapado nos templates;
- componentes sensíveis usam `textContent`, `.value` e `dataset` via DOM API;
- scripts inline não são permitidos pela CSP.

## Privacidade

Minimização de dados: apenas identidade mínima + dados funcionais do gerenciador.

A exclusão de conta apaga os dados funcionais e, após confirmação explícita e validação da sessão/MFA, remove permanentemente a identidade Auth pela Edge Function.
