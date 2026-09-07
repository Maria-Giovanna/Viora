-- Viora — schema relacional seguro para Supabase/PostgreSQL
-- Execute no SQL Editor de um projeto Supabase NOVO ou após exportar qualquer dado antigo.
-- O frontend usa somente sb_publishable_...; nenhuma chave secreta pode aparecer no navegador.

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Tabelas
-- -----------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  due_date date,
  color text not null default 'purple' check (color in ('purple','blue','pink','green','yellow','orange')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

create table if not exists public.tasks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  parent_id uuid references public.tasks(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 3000),
  completion_criteria text not null default '' check (char_length(completion_criteria) <= 1000),
  due_date date,
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes between 1 and 525600),
  initial_estimate_minutes integer check (initial_estimate_minutes is null or initial_estimate_minutes between 1 and 525600),
  status text not null default 'pending' check (status in ('pending','in_progress','completed')),
  tags text[] not null default '{}',
  user_does_not_know_how_to_start boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (user_id, id)
);

-- Compatibilidade com instalações de versões anteriores, nas quais toda tarefa
-- precisava pertencer a um projeto. A versão atual aceita tarefas avulsas.
alter table public.tasks alter column project_id drop not null;

create table if not exists public.task_dependencies (
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

create table if not exists public.timer_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  started_at timestamptz,
  ended_at timestamptz not null,
  duration_seconds integer not null check (duration_seconds between 0 and 31536000),
  created_at timestamptz not null default now()
);

create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_available_minutes integer check (last_available_minutes is null or last_available_minutes between 1 and 10080),
  active_project_id uuid references public.projects(id) on delete set null,
  active_timer_task_id uuid references public.tasks(id) on delete set null,
  active_timer_started_at timestamptz,
  active_timer_accumulated_seconds integer not null default 0 check (active_timer_accumulated_seconds between 0 and 31536000),
  active_timer_is_paused boolean not null default false,
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Integridade estrutural: usuário/projeto/pais/dependências/ciclos
-- -----------------------------------------------------------------------------

create or replace function public.taskflow_validate_task_row()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  project_owner uuid;
  parent_owner uuid;
  parent_project uuid;
begin
  if new.project_id is not null then
    select user_id into project_owner from public.projects where id = new.project_id;
    if project_owner is null or project_owner <> new.user_id then
      raise exception 'Projeto inválido para esta conta.' using errcode = '23514';
    end if;
  end if;

  if new.parent_id is not null then
    select user_id, project_id into parent_owner, parent_project
      from public.tasks where id = new.parent_id;
    if parent_owner is null or parent_owner <> new.user_id or parent_project is distinct from new.project_id then
      raise exception 'Tarefa-pai inválida.' using errcode = '23514';
    end if;

    if exists (
      with recursive ancestors(id) as (
        select new.parent_id
        union all
        select t.parent_id
        from public.tasks t
        join ancestors a on t.id = a.id
        where t.parent_id is not null
      )
      select 1 from ancestors where id = new.id
    ) then
      raise exception 'A hierarquia de tarefas não pode conter ciclos.' using errcode = '23514';
    end if;

    -- Ao receber um filho, a tarefa-pai vira agrupador. Agrupadores não podem
    -- manter dependências operacionais próprias.
    if exists (
      select 1 from public.task_dependencies
      where task_id = new.parent_id or depends_on_task_id = new.parent_id
    ) then
      raise exception 'Uma tarefa com dependências não pode virar agrupador sem reorganizar as relações.' using errcode = '23514';
    end if;
  end if;

  if cardinality(new.tags) > 12 then
    raise exception 'Uma tarefa pode ter no máximo 12 tags.' using errcode = '23514';
  end if;
  if exists (select 1 from unnest(new.tags) tag where char_length(tag) > 32) then
    raise exception 'Cada tag pode ter no máximo 32 caracteres.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists taskflow_validate_task_row_trigger on public.tasks;
create trigger taskflow_validate_task_row_trigger
before insert or update on public.tasks
for each row execute function public.taskflow_validate_task_row();

create or replace function public.taskflow_validate_dependency()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  task_owner uuid;
  dependency_owner uuid;
  task_project uuid;
  dependency_project uuid;
begin
  select user_id, project_id into task_owner, task_project
    from public.tasks where id = new.task_id;
  select user_id, project_id into dependency_owner, dependency_project
    from public.tasks where id = new.depends_on_task_id;

  if task_owner is null or dependency_owner is null
     or task_owner <> new.user_id or dependency_owner <> new.user_id then
    raise exception 'Dependência entre contas diferentes não é permitida.' using errcode = '23514';
  end if;

  if task_project is distinct from dependency_project then
    raise exception 'Dependências precisam estar no mesmo contexto: mesmo projeto ou ambas avulsas.' using errcode = '23514';
  end if;

  if exists (select 1 from public.tasks where parent_id = new.task_id)
     or exists (select 1 from public.tasks where parent_id = new.depends_on_task_id) then
    raise exception 'Dependências só podem ligar tarefas executáveis (folhas).' using errcode = '23514';
  end if;

  -- Direção do grafo: depends_on_task_id -> task_id.
  -- Para adicionar prerequisite -> task, não pode já existir caminho task -> prerequisite.
  if exists (
    with recursive reach(id) as (
      select d.task_id
      from public.task_dependencies d
      where d.user_id = new.user_id
        and d.depends_on_task_id = new.task_id
      union
      select d.task_id
      from public.task_dependencies d
      join reach r on d.depends_on_task_id = r.id
      where d.user_id = new.user_id
    )
    select 1 from reach where id = new.depends_on_task_id
  ) then
    raise exception 'Dependência rejeitada: o grafo formaria um ciclo.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists taskflow_validate_dependency_trigger on public.task_dependencies;
create trigger taskflow_validate_dependency_trigger
before insert or update on public.task_dependencies
for each row execute function public.taskflow_validate_dependency();


create or replace function public.taskflow_validate_timer_session()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  task_owner uuid;
begin
  select user_id into task_owner from public.tasks where id = new.task_id;
  if task_owner is null or task_owner <> new.user_id then
    raise exception 'Sessão de cronômetro aponta para tarefa de outra conta.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists taskflow_validate_timer_session_trigger on public.timer_sessions;
create trigger taskflow_validate_timer_session_trigger
before insert or update on public.timer_sessions
for each row execute function public.taskflow_validate_timer_session();

create or replace function public.taskflow_validate_preferences()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  owner_id uuid;
begin
  if new.active_project_id is not null then
    select user_id into owner_id from public.projects where id = new.active_project_id;
    if owner_id is null or owner_id <> new.user_id then
      raise exception 'Projeto ativo inválido para esta conta.' using errcode = '23514';
    end if;
  end if;
  if new.active_timer_task_id is not null then
    select user_id into owner_id from public.tasks where id = new.active_timer_task_id;
    if owner_id is null or owner_id <> new.user_id then
      raise exception 'Cronômetro ativo aponta para tarefa de outra conta.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists taskflow_validate_preferences_trigger on public.user_preferences;
create trigger taskflow_validate_preferences_trigger
before insert or update on public.user_preferences
for each row execute function public.taskflow_validate_preferences();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.timer_sessions enable row level security;
alter table public.user_preferences enable row level security;

revoke all on public.profiles, public.projects, public.tasks,
  public.task_dependencies, public.timer_sessions, public.user_preferences from anon;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, update, delete on public.task_dependencies to authenticated;
grant select, insert, update, delete on public.timer_sessions to authenticated;
grant select, insert, update, delete on public.user_preferences to authenticated;

-- Políticas de propriedade.
do $$
declare
  tbl text;
begin
  foreach tbl in array array['projects','tasks','task_dependencies','timer_sessions','user_preferences'] loop
    execute format('drop policy if exists %I on public.%I', tbl || '_own_select', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_own_insert', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_own_update', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_own_delete', tbl);

    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', tbl || '_own_select', tbl);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', tbl || '_own_insert', tbl);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', tbl || '_own_update', tbl);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', tbl || '_own_delete', tbl);
  end loop;
end $$;

drop policy if exists profiles_own_select on public.profiles;
create policy profiles_own_select on public.profiles
for select to authenticated using ((select auth.uid()) = id);

drop policy if exists profiles_own_update on public.profiles;
create policy profiles_own_update on public.profiles
for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists profiles_own_delete on public.profiles;
-- Perfis não podem ser excluídos diretamente pelo cliente. Exclusão de conta
-- passa pela Edge Function privilegiada, que também remove auth.users.

-- MFA opt-in obrigatório depois que a conta possuir pelo menos um fator verificado.
-- Se não houver fator cadastrado, aal1 e aal2 são aceitos. Se houver, apenas aal2.
do $$
declare
  tbl text;
begin
  foreach tbl in array array['profiles','projects','tasks','task_dependencies','timer_sessions','user_preferences'] loop
    execute format('drop policy if exists %I on public.%I', tbl || '_mfa_if_enrolled', tbl);
    execute format($policy$
      create policy %I on public.%I
      as restrictive
      for all
      to authenticated
      using (
        array[(select auth.jwt()->>'aal')] <@ (
          select case
            when count(id) > 0 then array['aal2']::text[]
            else array['aal1','aal2']::text[]
          end
          from auth.mfa_factors
          where user_id = (select auth.uid()) and status = 'verified'
        )
      )
      with check (
        array[(select auth.jwt()->>'aal')] <@ (
          select case
            when count(id) > 0 then array['aal2']::text[]
            else array['aal1','aal2']::text[]
          end
          from auth.mfa_factors
          where user_id = (select auth.uid()) and status = 'verified'
        )
      )
    $policy$, tbl || '_mfa_if_enrolled', tbl);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Cadastro automático de perfil/preferências
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 60))
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

insert into public.profiles (id, display_name)
select id, left(coalesce(raw_user_meta_data ->> 'display_name', ''), 60)
from auth.users
on conflict (id) do nothing;

insert into public.user_preferences (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- -----------------------------------------------------------------------------
-- Salvamento atômico do estado do usuário em tabelas relacionais.
-- security invoker é proposital: RLS continua valendo dentro da função.
-- -----------------------------------------------------------------------------

create or replace function public.replace_user_state(p_state jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Autenticação obrigatória.' using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_state->'projects','[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_state->'tasks','[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_state->'timerSessions','[]'::jsonb)) <> 'array' then
    raise exception 'Estado inválido.' using errcode = '22023';
  end if;

  -- As exclusões e inserções fazem parte da mesma transação RPC. Qualquer erro faz rollback.
  delete from public.task_dependencies where user_id = uid;
  delete from public.timer_sessions where user_id = uid;
  delete from public.tasks where user_id = uid;
  delete from public.projects where user_id = uid;

  insert into public.projects (id, user_id, name, description, due_date, color, created_at, updated_at)
  select
    (p->>'id')::uuid,
    uid,
    left(trim(coalesce(p->>'name','')), 80),
    left(coalesce(p->>'description',''), 2000),
    nullif(p->>'dueDate','')::date,
    coalesce(nullif(p->>'color',''), 'purple'),
    coalesce(nullif(p->>'createdAt','')::timestamptz, now()),
    coalesce(nullif(p->>'updatedAt','')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_state->'projects','[]'::jsonb)) p;

  -- Pais vêm antes dos filhos no estado criado pelo app, mas a inserção em lote com FK
  -- auto-referente é melhor feita em duas etapas.
  insert into public.tasks (
    id, user_id, project_id, parent_id, name, description, completion_criteria,
    due_date, estimated_minutes, initial_estimate_minutes, status, tags,
    user_does_not_know_how_to_start, created_at, updated_at, started_at, completed_at
  )
  select
    (t->>'id')::uuid, uid, nullif(t->>'projectId','')::uuid, null,
    left(trim(coalesce(t->>'name','')), 120),
    left(coalesce(t->>'description',''), 3000),
    left(coalesce(t->>'completionCriteria',''), 1000),
    nullif(t->>'dueDate','')::date,
    nullif(t->>'estimatedMinutes','')::integer,
    nullif(t->>'initialEstimateMinutes','')::integer,
    coalesce(nullif(t->>'status',''),'pending'),
    coalesce(array(select left(value,32) from jsonb_array_elements_text(coalesce(t->'tags','[]'::jsonb))), '{}'),
    coalesce((t->>'userDoesNotKnowHowToStart')::boolean, false),
    coalesce(nullif(t->>'createdAt','')::timestamptz, now()),
    coalesce(nullif(t->>'updatedAt','')::timestamptz, now()),
    nullif(t->>'startedAt','')::timestamptz,
    nullif(t->>'completedAt','')::timestamptz
  from jsonb_array_elements(coalesce(p_state->'tasks','[]'::jsonb)) t;

  update public.tasks target
  set parent_id = (src->>'parentId')::uuid
  from jsonb_array_elements(coalesce(p_state->'tasks','[]'::jsonb)) src
  where target.user_id = uid
    and target.id = (src->>'id')::uuid
    and nullif(src->>'parentId','') is not null;

  insert into public.task_dependencies (user_id, task_id, depends_on_task_id)
  select uid, (t->>'id')::uuid, dep.value::uuid
  from jsonb_array_elements(coalesce(p_state->'tasks','[]'::jsonb)) t
  cross join lateral jsonb_array_elements_text(coalesce(t->'dependencyIds','[]'::jsonb)) dep(value);

  insert into public.timer_sessions (id, user_id, task_id, started_at, ended_at, duration_seconds)
  select
    (s->>'id')::uuid, uid, (s->>'taskId')::uuid,
    nullif(s->>'startedAt','')::timestamptz,
    coalesce(nullif(s->>'endedAt','')::timestamptz, now()),
    greatest(0, coalesce((s->>'durationSeconds')::integer,0))
  from jsonb_array_elements(coalesce(p_state->'timerSessions','[]'::jsonb)) s;

  insert into public.user_preferences (
    user_id, last_available_minutes, active_project_id, active_timer_task_id,
    active_timer_started_at, active_timer_accumulated_seconds, active_timer_is_paused, updated_at
  ) values (
    uid,
    nullif(p_state#>>'{preferences,lastAvailableMinutes}','')::integer,
    nullif(p_state#>>'{preferences,activeProjectId}','')::uuid,
    nullif(p_state#>>'{preferences,activeTimer,taskId}','')::uuid,
    nullif(p_state#>>'{preferences,activeTimer,startedAt}','')::timestamptz,
    greatest(0, coalesce(nullif(p_state#>>'{preferences,activeTimer,accumulatedSeconds}','')::integer,0)),
    coalesce(nullif(p_state#>>'{preferences,activeTimer,isPaused}','')::boolean,false),
    now()
  )
  on conflict (user_id) do update set
    last_available_minutes = excluded.last_available_minutes,
    active_project_id = excluded.active_project_id,
    active_timer_task_id = excluded.active_timer_task_id,
    active_timer_started_at = excluded.active_timer_started_at,
    active_timer_accumulated_seconds = excluded.active_timer_accumulated_seconds,
    active_timer_is_paused = excluded.active_timer_is_paused,
    updated_at = now();
end;
$$;

revoke all on function public.replace_user_state(jsonb) from public;
grant execute on function public.replace_user_state(jsonb) to authenticated;

-- A tabela antiga app_states, caso exista de uma versão anterior, não é usada pelo novo app.
-- Por segurança, retire acesso do cliente. Exporte dados antigos antes de removê-la manualmente.
do $$
begin
  if to_regclass('public.app_states') is not null then
    execute 'revoke all on public.app_states from anon, authenticated';
  end if;
end $$;
