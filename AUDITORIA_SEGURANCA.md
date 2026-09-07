# Auditoria de segurança — Viora

Data da revisão: 21/08/2026

## Resultado por requisito

| Requisito | Estado no código | Observação |
|---|---|---|
| RLS / isolamento entre usuários | Implementado | Todas as tabelas funcionais usam RLS por `auth.uid()`; MFA opt-in adiciona policy restritiva AAL2. |
| Chaves no frontend | Implementado | Config aceita somente `sb_publishable_...`; qualquer `sb_secret_...` é recusada. |
| Prevenção de XSS | Implementado com defesa em camadas | CSP sem scripts inline, validação de importação, UUIDs, limites de campos, `textContent` em fluxos sensíveis e escape explícito nos templates restantes. |
| Auth oficial | Implementado | `@supabase/supabase-js@2.112.3`; sem criação, decodificação ou persistência manual de JWT. |
| Privacidade / exclusão | Implementado | Coleta mínima; exclusão permanente por Edge Function autenticada, com MFA quando aplicável. |
| Força bruta / bots | Preparado + configuração externa necessária | Supabase Auth aplica rate limits; Turnstile já está integrado no frontend, mas precisa ser habilitado no Dashboard. |
| Enumeração de usuário | Implementado | Login e recuperação não distinguem usuário inexistente, senha errada ou conta não confirmada na mensagem visível. |
| MFA | Implementado | TOTP + AAL2 + RLS restritiva depois que o usuário opta por 2FA. |

## RLS

Tabelas protegidas:

- `profiles`;
- `projects`;
- `tasks`;
- `task_dependencies`;
- `timer_sessions`;
- `user_preferences`.

As operações funcionais exigem que o `user_id`/`id` seja igual ao `auth.uid()` da sessão. O cliente não possui permissão de `DELETE` direto sobre `profiles`; exclusão de conta passa pela Edge Function.

Além da RLS, triggers do PostgreSQL recusam referências de outra conta/projeto, dependências de agrupadores, hierarquia cíclica e grafo de dependências cíclico.

## Chaves

Frontend:

- permitido: `sb_publishable_...`;
- proibido: `sb_secret_...`;
- nenhuma chave administrativa é armazenada no repositório cliente.

A Edge Function usa `@supabase/server`, que recebe as chaves administrativas pelo ambiente da plataforma. Elas não são serializadas nem retornadas ao navegador.

## Sessão

A sessão é criada e atualizada exclusivamente pelo SDK oficial. O storage customizado é `window.sessionStorage`.

Limitação assumida: por ser uma SPA client-side, o token não é HttpOnly e um XSS bem-sucedido ainda poderia atingir a sessão. A mitigação é reduzir fortemente a possibilidade de execução de script não confiável por CSP, validação e renderização segura.

## XSS

Controles implementados:

- `script-src` não usa `unsafe-inline` nem `unsafe-eval`;
- não existe `eval()` ou `new Function()`;
- campos externos têm tamanho máximo;
- IDs precisam ser UUID válidos;
- JSON importado é validado antes de substituir o estado;
- referências inexistentes/cíclicas são rejeitadas;
- fluxos sensíveis usam `textContent`, `.value`, `dataset` e DOM API;
- nos templates estáticos restantes, todo texto controlado pelo usuário é passado por `escapeHtml()` e atributos de ID recebem somente UUIDs validados.

Para produção, prefira também configurar a CSP como **header HTTP** no serviço de hospedagem. O `<meta http-equiv="Content-Security-Policy">` continua útil em hospedagem estática, mas algumas diretivas, como proteção contra framing, devem ser aplicadas por header.

## Autenticação

Implementado:

- cadastro com e-mail/senha;
- confirmação de e-mail;
- login `signInWithPassword`;
- recuperação de senha;
- troca de senha com `current_password`;
- logout pelo SDK;
- TOTP/MFA;
- mensagens genéricas em falhas de autenticação.

Senhas não existem nas tabelas públicas da aplicação. O armazenamento de credenciais fica sob responsabilidade do Supabase Auth.

## Rate limiting e CAPTCHA

O código não tenta criar um rate limiter caseiro no navegador. O rate limiting real é aplicado no Supabase Auth. O Dashboard permite configurar limites de autenticação e retorna 429 quando excedidos.

Turnstile está integrado para cadastro, login e recuperação. Ele só fica efetivamente ativo depois que a Site Key é adicionada ao frontend e a Secret Key é configurada em **Authentication > Bot and Abuse Protection**.

## Privacidade e exclusão

Dados coletados:

- e-mail de autenticação;
- nome de exibição;
- projetos/tarefas e suas propriedades funcionais;
- sessões do cronômetro;
- preferências do aplicativo.

Não há coleta de CPF, telefone, endereço, localização ou outros dados sem finalidade para o produto.

A exclusão exige confirmação explícita. Se houver MFA cadastrado, exige AAL2. A Edge Function remove os dados funcionais e depois exclui permanentemente a identidade Auth.

## Pontos que dependem de configuração no Supabase

O código sozinho não consegue confirmar o estado do Dashboard. Antes da entrega, valide:

- que `supabase/schema.sql` foi executado integralmente;
- que Confirm Email está ativo;
- que a política de senha está configurada;
- que Turnstile está ativo;
- que os rate limits estão revisados;
- que MFA/TOTP está habilitado;
- que a Edge Function `delete-account` foi implantada;
- que `TASKFLOW_ALLOWED_ORIGINS` contém apenas localhost durante desenvolvimento e o domínio HTTPS final em produção.
