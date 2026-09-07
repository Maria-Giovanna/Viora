import { isSupabaseConfigured, supabaseClient } from './supabase-client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS = new Set(['pending', 'in_progress', 'completed']);
const COLORS = new Set(['purple', 'blue', 'pink', 'green', 'yellow', 'orange']);

export function createEmptyDatabase() {
  return {
    schemaVersion: 3,
    projects: [],
    tasks: [],
    timerSessions: [],
    preferences: {
      lastAvailableMinutes: null,
      activeTimer: null,
      activeProjectId: null
    }
  };
}

function requireCloud() {
  if (!isSupabaseConfigured || !supabaseClient) {
    throw new Error('Supabase ainda não foi configurado.');
  }
  return supabaseClient;
}

function cleanString(value, max, field, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw new Error(`${field} é obrigatório.`);
  if (text.length > max) throw new Error(`${field} excede ${max} caracteres.`);
  return text;
}

function cleanUuid(value, field, { nullable = false } = {}) {
  if ((value == null || value === '') && nullable) return null;
  const text = String(value ?? '');
  if (!UUID_RE.test(text)) throw new Error(`${field} possui um identificador inválido.`);
  return text.toLowerCase();
}

function cleanDate(value, field) {
  if (!value) return null;
  const text = String(value);
  if (!DATE_RE.test(text) || Number.isNaN(new Date(`${text}T12:00:00Z`).getTime())) {
    throw new Error(`${field} possui uma data inválida.`);
  }
  return text;
}

function cleanIso(value, field, { nullable = true } = {}) {
  if (!value && nullable) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} possui uma data/hora inválida.`);
  return date.toISOString();
}

function cleanInteger(value, field, min, max, { nullable = false } = {}) {
  if ((value == null || value === '') && nullable) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${field} precisa ser um número inteiro entre ${min} e ${max}.`);
  }
  return number;
}

function assertNoParentCycles(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    const seen = new Set([task.id]);
    let parentId = task.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new Error('A hierarquia de tarefas contém um ciclo.');
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) throw new Error('Uma tarefa aponta para uma tarefa-pai inexistente.');
      if (parent.projectId !== task.projectId) throw new Error('Uma subtarefa precisa estar no mesmo contexto da tarefa-pai.');
      parentId = parent.parentId;
    }
  }
}

function assertDependencies(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Set(tasks.filter((task) => task.parentId).map((task) => task.parentId));
  const graph = new Map(tasks.map((task) => [task.id, []]));

  for (const task of tasks) {
    if (children.has(task.id) && task.dependencyIds.length) {
      throw new Error('Agrupadores não podem possuir dependências operacionais.');
    }
    for (const depId of task.dependencyIds) {
      const dep = byId.get(depId);
      if (!dep) throw new Error('Uma dependência aponta para uma tarefa inexistente.');
      if (dep.projectId !== task.projectId) throw new Error('Dependências precisam estar no mesmo contexto: mesmo projeto ou ambas avulsas.');
      if (children.has(depId)) throw new Error('Dependências só podem apontar para tarefas executáveis.');
      graph.get(depId).push(task.id);
    }
  }

  const state = new Map();
  function visit(id) {
    if (state.get(id) === 1) throw new Error('O grafo de dependências contém um ciclo.');
    if (state.get(id) === 2) return;
    state.set(id, 1);
    for (const next of graph.get(id) ?? []) visit(next);
    state.set(id, 2);
  }
  for (const id of graph.keys()) visit(id);
}

export function sanitizeDatabase(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Banco inválido.');
  if (!Array.isArray(raw.projects) || !Array.isArray(raw.tasks)) {
    throw new Error('O arquivo precisa conter projects[] e tasks[].');
  }
  if (raw.projects.length > 500 || raw.tasks.length > 10000 || (raw.timerSessions?.length ?? 0) > 50000) {
    throw new Error('O arquivo excede os limites de segurança do aplicativo.');
  }

  const projectIds = new Set();
  const projects = raw.projects.map((project) => {
    const id = cleanUuid(project.id, 'ID do projeto');
    if (projectIds.has(id)) throw new Error('Há IDs de projeto duplicados.');
    projectIds.add(id);
    const color = String(project.color || 'purple');
    if (!COLORS.has(color)) throw new Error('Um projeto possui cor inválida.');
    return {
      id,
      name: cleanString(project.name, 80, 'Nome do projeto', { required: true }),
      description: cleanString(project.description, 2000, 'Descrição do projeto'),
      dueDate: cleanDate(project.dueDate, 'Prazo do projeto'),
      color,
      createdAt: cleanIso(project.createdAt || new Date().toISOString(), 'Criação do projeto', { nullable: false }),
      updatedAt: cleanIso(project.updatedAt || new Date().toISOString(), 'Atualização do projeto', { nullable: false })
    };
  });

  const taskIds = new Set();
  const tasks = raw.tasks.map((task) => {
    const id = cleanUuid(task.id, 'ID da tarefa');
    if (taskIds.has(id)) throw new Error('Há IDs de tarefa duplicados.');
    taskIds.add(id);
    const projectId = cleanUuid(task.projectId, 'Projeto da tarefa', { nullable: true });
    if (projectId && !projectIds.has(projectId)) throw new Error('Uma tarefa aponta para projeto inexistente.');
    const status = String(task.status || 'pending');
    if (!STATUS.has(status)) throw new Error('Uma tarefa possui status inválido.');
    const dependencyIds = [...new Set((Array.isArray(task.dependencyIds) ? task.dependencyIds : []).map((idValue) => cleanUuid(idValue, 'Dependência')))];
    if (dependencyIds.includes(id)) throw new Error('Uma tarefa não pode depender dela mesma.');
    const tags = (Array.isArray(task.tags) ? task.tags : []).map((tag) => cleanString(tag, 32, 'Tag')).filter(Boolean);
    if (tags.length > 12) throw new Error('Uma tarefa pode ter no máximo 12 tags.');
    return {
      id,
      projectId,
      parentId: cleanUuid(task.parentId, 'Tarefa-pai', { nullable: true }),
      name: cleanString(task.name, 120, 'Nome da tarefa', { required: true }),
      description: cleanString(task.description, 3000, 'Descrição da tarefa'),
      completionCriteria: cleanString(task.completionCriteria, 1000, 'Critério de conclusão'),
      dueDate: cleanDate(task.dueDate, 'Prazo da tarefa'),
      estimatedMinutes: cleanInteger(task.estimatedMinutes, 'Tempo estimado', 1, 525600, { nullable: true }),
      initialEstimateMinutes: cleanInteger(task.initialEstimateMinutes, 'Estimativa inicial', 1, 525600, { nullable: true }),
      status,
      dependencyIds,
      tags,
      userDoesNotKnowHowToStart: Boolean(task.userDoesNotKnowHowToStart),
      createdAt: cleanIso(task.createdAt || new Date().toISOString(), 'Criação da tarefa', { nullable: false }),
      updatedAt: cleanIso(task.updatedAt || new Date().toISOString(), 'Atualização da tarefa', { nullable: false }),
      startedAt: cleanIso(task.startedAt, 'Início da tarefa'),
      completedAt: cleanIso(task.completedAt, 'Conclusão da tarefa')
    };
  });

  for (const task of tasks) {
    if (task.parentId && !taskIds.has(task.parentId)) throw new Error('Uma tarefa aponta para tarefa-pai inexistente.');
  }
  assertNoParentCycles(tasks);
  assertDependencies(tasks);

  const timerSessions = (Array.isArray(raw.timerSessions) ? raw.timerSessions : []).map((session) => {
    const taskId = cleanUuid(session.taskId, 'Tarefa do cronômetro');
    if (!taskIds.has(taskId)) throw new Error('Uma sessão de cronômetro aponta para tarefa inexistente.');
    return {
      id: cleanUuid(session.id, 'ID do cronômetro'),
      taskId,
      startedAt: cleanIso(session.startedAt, 'Início do cronômetro'),
      endedAt: cleanIso(session.endedAt || new Date().toISOString(), 'Fim do cronômetro', { nullable: false }),
      durationSeconds: cleanInteger(session.durationSeconds ?? 0, 'Tempo real', 0, 31536000)
    };
  });

  const pref = raw.preferences && typeof raw.preferences === 'object' ? raw.preferences : {};
  const activeProjectId = cleanUuid(pref.activeProjectId, 'Projeto ativo', { nullable: true });
  if (activeProjectId && !projectIds.has(activeProjectId)) throw new Error('O projeto ativo não existe.');

  let activeTimer = null;
  if (pref.activeTimer) {
    const taskId = cleanUuid(pref.activeTimer.taskId, 'Tarefa do cronômetro ativo');
    if (!taskIds.has(taskId)) throw new Error('O cronômetro ativo aponta para tarefa inexistente.');
    activeTimer = {
      taskId,
      startedAt: cleanIso(pref.activeTimer.startedAt, 'Início do cronômetro ativo'),
      accumulatedSeconds: cleanInteger(pref.activeTimer.accumulatedSeconds ?? 0, 'Tempo acumulado', 0, 31536000),
      isPaused: Boolean(pref.activeTimer.isPaused)
    };
  }

  return {
    schemaVersion: 3,
    projects,
    tasks,
    timerSessions,
    preferences: {
      lastAvailableMinutes: cleanInteger(pref.lastAvailableMinutes, 'Tempo disponível', 1, 10080, { nullable: true }),
      activeTimer,
      activeProjectId
    }
  };
}

function fromCloud(projectRows, taskRows, dependencyRows, timerRows, preferencesRow) {
  const dependenciesByTask = new Map();
  for (const row of dependencyRows ?? []) {
    if (!dependenciesByTask.has(row.task_id)) dependenciesByTask.set(row.task_id, []);
    dependenciesByTask.get(row.task_id).push(row.depends_on_task_id);
  }

  const db = {
    schemaVersion: 3,
    projects: (projectRows ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      dueDate: row.due_date,
      color: row.color,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    tasks: (taskRows ?? []).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      parentId: row.parent_id,
      name: row.name,
      description: row.description ?? '',
      completionCriteria: row.completion_criteria ?? '',
      dueDate: row.due_date,
      estimatedMinutes: row.estimated_minutes,
      initialEstimateMinutes: row.initial_estimate_minutes,
      status: row.status,
      dependencyIds: dependenciesByTask.get(row.id) ?? [],
      tags: row.tags ?? [],
      userDoesNotKnowHowToStart: Boolean(row.user_does_not_know_how_to_start),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    })),
    timerSessions: (timerRows ?? []).map((row) => ({
      id: row.id,
      taskId: row.task_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationSeconds: row.duration_seconds
    })),
    preferences: {
      lastAvailableMinutes: preferencesRow?.last_available_minutes ?? null,
      activeProjectId: preferencesRow?.active_project_id ?? null,
      activeTimer: preferencesRow?.active_timer_task_id ? {
        taskId: preferencesRow.active_timer_task_id,
        startedAt: preferencesRow.active_timer_started_at,
        accumulatedSeconds: preferencesRow.active_timer_accumulated_seconds ?? 0,
        isPaused: Boolean(preferencesRow.active_timer_is_paused)
      } : null
    }
  };

  return sanitizeDatabase(db);
}

export async function loadDatabase(userId) {
  cleanUuid(userId, 'Usuário');
  const client = requireCloud();
  const [projectsRes, tasksRes, dependenciesRes, timersRes, preferencesRes] = await Promise.all([
    client.from('projects').select('id,name,description,due_date,color,created_at,updated_at').order('created_at'),
    client.from('tasks').select('id,project_id,parent_id,name,description,completion_criteria,due_date,estimated_minutes,initial_estimate_minutes,status,tags,user_does_not_know_how_to_start,created_at,updated_at,started_at,completed_at').order('created_at'),
    client.from('task_dependencies').select('task_id,depends_on_task_id'),
    client.from('timer_sessions').select('id,task_id,started_at,ended_at,duration_seconds').order('ended_at'),
    client.from('user_preferences').select('last_available_minutes,active_project_id,active_timer_task_id,active_timer_started_at,active_timer_accumulated_seconds,active_timer_is_paused').eq('user_id', userId).maybeSingle()
  ]);

  for (const result of [projectsRes, tasksRes, dependenciesRes, timersRes, preferencesRes]) {
    if (result.error) throw result.error;
  }

  return fromCloud(projectsRes.data, tasksRes.data, dependenciesRes.data, timersRes.data, preferencesRes.data);
}

let saveChain = Promise.resolve();

export function saveDatabase(db, userId) {
  cleanUuid(userId, 'Usuário');
  const snapshot = sanitizeDatabase(structuredClone(db));
  saveChain = saveChain.catch(() => undefined).then(async () => {
    const client = requireCloud();
    const { error } = await client.rpc('replace_user_state', { p_state: snapshot });
    if (error) throw error;
  });
  return saveChain;
}

export async function clearDatabase(userId) {
  const empty = createEmptyDatabase();
  await saveDatabase(empty, userId);
  return empty;
}

export function exportDatabase(db) {
  return JSON.stringify(sanitizeDatabase(db), null, 2);
}

export function importDatabase(jsonText) {
  if (String(jsonText).length > 8_000_000) throw new Error('Arquivo JSON grande demais.');
  return sanitizeDatabase(JSON.parse(jsonText));
}
