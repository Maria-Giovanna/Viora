export const STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed'
});

export const PRIORITY_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
});

export function makeId() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('Este navegador não oferece geração segura de UUID. Atualize o navegador.');
  }
  return globalThis.crypto.randomUUID();
}

export function getProject(db, projectId) {
  if (!projectId) return null;
  return db.projects.find((project) => project.id === projectId) ?? null;
}

export function getTask(db, taskId) {
  return db.tasks.find((task) => task.id === taskId) ?? null;
}

export function getChildren(tasks, parentId) {
  return tasks.filter((task) => task.parentId === parentId);
}

export function isGroup(task, tasks) {
  return tasks.some((candidate) => candidate.parentId === task.id);
}

export function getDescendantLeaves(taskId, tasks) {
  const children = getChildren(tasks, taskId);
  if (children.length === 0) {
    const task = tasks.find((item) => item.id === taskId);
    return task ? [task] : [];
  }

  return children.flatMap((child) => getDescendantLeaves(child.id, tasks));
}

export function getProjectLeaves(projectId, tasks) {
  return tasks.filter((task) => task.projectId === projectId && !isGroup(task, tasks));
}

export function getAncestors(task, tasks) {
  const result = [];
  let current = task;
  const seen = new Set();

  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = tasks.find((item) => item.id === current.parentId);
    if (!parent) break;
    result.push(parent);
    current = parent;
  }

  return result;
}

export function getEffectiveDueDate(task, db) {
  if (task.dueDate) return task.dueDate;

  for (const ancestor of getAncestors(task, db.tasks)) {
    if (ancestor.dueDate) return ancestor.dueDate;
  }

  return getProject(db, task.projectId)?.dueDate ?? null;
}

export function calculateGroupStatus(taskId, tasks) {
  const leaves = getDescendantLeaves(taskId, tasks);
  if (leaves.length === 0) {
    return tasks.find((task) => task.id === taskId)?.status ?? STATUS.PENDING;
  }

  if (leaves.every((leaf) => leaf.status === STATUS.COMPLETED)) return STATUS.COMPLETED;
  if (leaves.some((leaf) => leaf.status !== STATUS.PENDING)) return STATUS.IN_PROGRESS;
  return STATUS.PENDING;
}

export function getComputedStatus(task, tasks) {
  return isGroup(task, tasks) ? calculateGroupStatus(task.id, tasks) : task.status;
}

export function calculateProgress(taskId, tasks) {
  const leaves = getDescendantLeaves(taskId, tasks);
  if (leaves.length === 0) return 0;
  const completed = leaves.filter((leaf) => leaf.status === STATUS.COMPLETED).length;
  return Math.round((completed / leaves.length) * 100);
}

export function calculateEffort(taskId, tasks) {
  return getDescendantLeaves(taskId, tasks)
    .reduce((total, leaf) => total + Math.max(0, Number(leaf.estimatedMinutes) || 0), 0);
}

export function getDependencyTasks(task, tasks) {
  return (task.dependencyIds ?? [])
    .map((id) => tasks.find((candidate) => candidate.id === id))
    .filter(Boolean);
}

export function getBlockingTasks(task, tasks) {
  return getDependencyTasks(task, tasks)
    .filter((dependency) => getComputedStatus(dependency, tasks) !== STATUS.COMPLETED);
}

export function isTaskBlocked(task, tasks) {
  if (isGroup(task, tasks)) return false;
  return getBlockingTasks(task, tasks).length > 0;
}

export function buildDependencyGraph(projectId, tasks) {
  const leaves = getProjectLeaves(projectId, tasks);
  const leafIds = new Set(leaves.map((task) => task.id));
  const graph = new Map(leaves.map((task) => [task.id, []]));

  for (const task of leaves) {
    for (const dependencyId of task.dependencyIds ?? []) {
      if (leafIds.has(dependencyId)) {
        graph.get(dependencyId).push(task.id); // dependency -> dependent
      }
    }
  }

  return graph;
}

export function buildPredecessorMap(projectId, tasks) {
  const leaves = getProjectLeaves(projectId, tasks);
  const leafIds = new Set(leaves.map((task) => task.id));
  return new Map(leaves.map((task) => [
    task.id,
    (task.dependencyIds ?? []).filter((id) => leafIds.has(id))
  ]));
}

export function hasPath(graph, startId, targetId) {
  if (startId === targetId) return true;
  const visited = new Set();
  const stack = [startId];

  while (stack.length) {
    const current = stack.pop();
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const next of graph.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }

  return false;
}

export function wouldCreateCycle(db, taskId, dependencyId) {
  const task = getTask(db, taskId);
  const dependency = getTask(db, dependencyId);
  if (!task || !dependency) return { createsCycle: false, path: [] };
  if (task.projectId !== dependency.projectId) {
    return { createsCycle: false, path: [], invalidReason: 'Dependências precisam estar no mesmo contexto: no mesmo projeto ou ambas como tarefas avulsas.' };
  }
  if (taskId === dependencyId) {
    return { createsCycle: true, path: [taskId, taskId] };
  }

  // The stored meaning is: task depends on dependency.
  // In the dependency graph, edge dependency -> task. Adding this edge creates
  // a cycle if task can already reach dependency.
  const graph = buildDependencyGraph(task.projectId, db.tasks);
  const createsCycle = hasPath(graph, taskId, dependencyId);
  if (!createsCycle) return { createsCycle: false, path: [] };

  return {
    createsCycle: true,
    path: findPath(graph, taskId, dependencyId).concat(taskId)
  };
}

export function findPath(graph, startId, targetId) {
  const queue = [[startId, [startId]]];
  const visited = new Set();

  while (queue.length) {
    const [current, path] = queue.shift();
    if (current === targetId) return path;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const next of graph.get(current) ?? []) {
      if (!visited.has(next)) queue.push([next, [...path, next]]);
    }
  }

  return [];
}

export function validateDependency(db, taskId, dependencyId) {
  const task = getTask(db, taskId);
  const dependency = getTask(db, dependencyId);

  if (!task || !dependency) {
    return { ok: false, message: 'A tarefa ou o pré-requisito não existe.' };
  }
  if (isGroup(task, db.tasks) || isGroup(dependency, db.tasks)) {
    return { ok: false, message: 'Dependências só podem ligar tarefas executáveis, não agrupadores.' };
  }
  if (task.projectId !== dependency.projectId) {
    return { ok: false, message: 'As duas tarefas precisam estar no mesmo contexto: no mesmo projeto ou ambas como tarefas avulsas.' };
  }
  if ((task.dependencyIds ?? []).includes(dependencyId)) {
    return { ok: false, message: 'Essa dependência já existe.' };
  }

  const cycle = wouldCreateCycle(db, taskId, dependencyId);
  if (cycle.createsCycle) {
    const names = cycle.path.map((id) => getTask(db, id)?.name ?? id);
    return {
      ok: false,
      cyclePath: cycle.path,
      message: `Dependência não criada: isso formaria um ciclo (${names.join(' → ')}).`
    };
  }

  return { ok: true };
}

export function addDependency(db, taskId, dependencyId) {
  const validation = validateDependency(db, taskId, dependencyId);
  if (!validation.ok) return validation;

  const task = getTask(db, taskId);
  task.dependencyIds = [...(task.dependencyIds ?? []), dependencyId];
  task.updatedAt = new Date().toISOString();
  return { ok: true };
}

export function removeDependency(db, taskId, dependencyId) {
  const task = getTask(db, taskId);
  if (!task) return false;
  task.dependencyIds = (task.dependencyIds ?? []).filter((id) => id !== dependencyId);
  task.updatedAt = new Date().toISOString();
  return true;
}

function topologicalOrder(projectId, tasks) {
  const graph = buildDependencyGraph(projectId, tasks);
  const indegree = new Map([...graph.keys()].map((id) => [id, 0]));

  for (const successors of graph.values()) {
    for (const successor of successors) {
      indegree.set(successor, (indegree.get(successor) ?? 0) + 1);
    }
  }

  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  const order = [];

  while (queue.length) {
    const current = queue.shift();
    order.push(current);
    for (const next of graph.get(current) ?? []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  if (order.length !== graph.size) {
    throw new Error('O grafo contém um ciclo e não pode ser planejado.');
  }

  return { order, graph };
}

export function analyzeProject(db, projectId) {
  const leaves = getProjectLeaves(projectId, db.tasks);
  const taskMap = new Map(leaves.map((task) => [task.id, task]));

  if (leaves.length === 0) {
    return {
      effortMinutes: 0,
      projectedDurationMinutes: 0,
      earliestStart: new Map(),
      earliestFinish: new Map(),
      latestStart: new Map(),
      latestFinish: new Map(),
      slack: new Map(),
      criticalPathIds: [],
      criticalTaskIds: new Set(),
      unlockCounts: new Map(),
      order: []
    };
  }

  const { order, graph } = topologicalOrder(projectId, db.tasks);
  const predecessors = buildPredecessorMap(projectId, db.tasks);
  const earliestStart = new Map();
  const earliestFinish = new Map();
  const bestPredecessor = new Map();

  for (const id of order) {
    const preds = predecessors.get(id) ?? [];
    let start = 0;
    let chosen = null;

    for (const predId of preds) {
      const finish = earliestFinish.get(predId) ?? 0;
      if (finish > start || chosen === null) {
        start = Math.max(start, finish);
        if (finish >= start) chosen = predId;
      }
    }

    const duration = Math.max(0, Number(taskMap.get(id)?.estimatedMinutes) || 0);
    earliestStart.set(id, start);
    earliestFinish.set(id, start + duration);
    if (chosen) bestPredecessor.set(id, chosen);
  }

  const projectedDurationMinutes = Math.max(...earliestFinish.values(), 0);
  const latestFinish = new Map();
  const latestStart = new Map();

  for (const id of [...order].reverse()) {
    const successors = graph.get(id) ?? [];
    const duration = Math.max(0, Number(taskMap.get(id)?.estimatedMinutes) || 0);
    let finish;

    if (successors.length === 0) {
      finish = projectedDurationMinutes;
    } else {
      finish = Math.min(...successors.map((successorId) => latestStart.get(successorId)));
    }

    latestFinish.set(id, finish);
    latestStart.set(id, finish - duration);
  }

  const slack = new Map();
  const criticalTaskIds = new Set();
  for (const id of order) {
    const value = Math.max(0, (latestStart.get(id) ?? 0) - (earliestStart.get(id) ?? 0));
    slack.set(id, value);
    if (Math.abs(value) < 0.0001) criticalTaskIds.add(id);
  }

  // Build one representative critical path ending at the latest-finishing task.
  let endId = order.reduce((best, id) => {
    if (!best) return id;
    return (earliestFinish.get(id) ?? 0) > (earliestFinish.get(best) ?? 0) ? id : best;
  }, null);

  const criticalPathIds = [];
  while (endId) {
    criticalPathIds.unshift(endId);
    const preds = predecessors.get(endId) ?? [];
    const next = preds
      .filter((predId) => criticalTaskIds.has(predId))
      .find((predId) => Math.abs((earliestFinish.get(predId) ?? 0) - (earliestStart.get(endId) ?? 0)) < 0.0001);
    endId = next ?? null;
  }

  const unlockCounts = new Map();
  for (const id of order) {
    unlockCounts.set(id, countReachable(graph, id));
  }

  return {
    effortMinutes: leaves.reduce((sum, task) => sum + (Number(task.estimatedMinutes) || 0), 0),
    projectedDurationMinutes,
    earliestStart,
    earliestFinish,
    latestStart,
    latestFinish,
    slack,
    criticalPathIds,
    criticalTaskIds,
    unlockCounts,
    order
  };
}

function countReachable(graph, startId) {
  const visited = new Set();
  const stack = [...(graph.get(startId) ?? [])];
  while (stack.length) {
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(graph.get(current) ?? []));
  }
  return visited.size;
}

export function calculatePriority(db, task, projectAnalysis = null, now = new Date()) {
  if (isGroup(task, db.tasks)) {
    return { score: 0, level: PRIORITY_LEVELS.LOW, reasons: ['Agrupadores não recebem prioridade operacional.'] };
  }

  const analysis = projectAnalysis ?? analyzeProject(db, task.projectId);
  const dueDate = getEffectiveDueDate(task, db);
  let urgency = 20;
  let daysLeft = null;

  if (dueDate) {
    const end = new Date(`${dueDate}T23:59:59`);
    daysLeft = Math.ceil((end.getTime() - now.getTime()) / 86400000);
    if (daysLeft < 0) urgency = 100;
    else if (daysLeft <= 1) urgency = 100;
    else if (daysLeft <= 3) urgency = 85;
    else if (daysLeft <= 7) urgency = 70;
    else if (daysLeft <= 14) urgency = 50;
    else if (daysLeft <= 30) urgency = 30;
    else urgency = 15;
  }

  const critical = analysis.criticalTaskIds.has(task.id) ? 100 : 0;
  const unlockCount = analysis.unlockCounts.get(task.id) ?? 0;
  const unlock = Math.min(100, unlockCount * 20);
  const slackMinutes = analysis.slack.get(task.id) ?? analysis.projectedDurationMinutes;
  let noSlack = 15;
  if (slackMinutes <= 0) noSlack = 100;
  else if (slackMinutes <= 60) noSlack = 90;
  else if (slackMinutes <= 180) noSlack = 75;
  else if (slackMinutes <= 480) noSlack = 55;
  else noSlack = 25;

  const score = Math.round(
    urgency * 0.40 +
    critical * 0.25 +
    unlock * 0.20 +
    noSlack * 0.15
  );

  let level = PRIORITY_LEVELS.LOW;
  if (score >= 85) level = PRIORITY_LEVELS.CRITICAL;
  else if (score >= 60) level = PRIORITY_LEVELS.HIGH;
  else if (score >= 30) level = PRIORITY_LEVELS.MEDIUM;

  const reasons = [];
  if (daysLeft !== null) {
    if (daysLeft < 0) reasons.push(`Prazo vencido há ${Math.abs(daysLeft)} dia(s).`);
    else if (daysLeft === 0) reasons.push('Prazo termina hoje.');
    else reasons.push(`Prazo em ${daysLeft} dia(s).`);
  } else {
    reasons.push('Sem prazo próprio; usa apenas o impacto estrutural.');
  }
  if (critical) reasons.push('Está no caminho crítico.');
  if (unlockCount > 0) reasons.push(`Desbloqueia ${unlockCount} tarefa(s) direta ou indiretamente.`);
  if (slackMinutes <= 0) reasons.push('Não possui folga no planejamento.');
  else reasons.push(`Folga estrutural de ${formatMinutes(slackMinutes)}.`);

  return { score, level, reasons, dueDate, daysLeft, slackMinutes, unlockCount };
}

export function recommendTasks(db, availableMinutes = null) {
  const candidates = db.tasks.filter((task) => {
    if (isGroup(task, db.tasks)) return false;
    if (task.status === STATUS.COMPLETED) return false;
    return !isTaskBlocked(task, db.tasks);
  });

  const analyses = new Map();
  const rows = candidates.map((task) => {
    if (!analyses.has(task.projectId)) analyses.set(task.projectId, analyzeProject(db, task.projectId));
    const priority = calculatePriority(db, task, analyses.get(task.projectId));
    const estimate = Number(task.estimatedMinutes) || 0;
    const tolerance = availableMinutes == null ? true : estimate <= Math.ceil(availableMinutes * 1.15);
    return { task, priority, estimate, fits: tolerance };
  });

  const fitting = availableMinutes == null ? rows : rows.filter((row) => row.fits);
  return fitting
    .sort((a, b) => {
      if (b.priority.score !== a.priority.score) return b.priority.score - a.priority.score;
      return a.estimate - b.estimate;
    })
    .slice(0, 5);
}

export function calculateDecomposition(task) {
  const title = (task.name ?? '').trim().toLowerCase();
  const vagueVerbs = ['estudar', 'aprender', 'melhorar', 'organizar', 'fazer', 'desenvolver', 'resolver', 'preparar', 'pesquisar', 'trabalhar'];
  let score = 0;
  const reasons = [];

  const duration = Number(task.estimatedMinutes) || 0;
  if (!duration) {
    score += 1;
    reasons.push('Ainda não possui duração estimada.');
  }
  if (duration > 120) {
    score += 2;
    reasons.push('Leva mais de 2 horas.');
  }
  if (duration > 360) {
    score += 2;
    reasons.push('Leva mais de 6 horas.');
  }
  if (vagueVerbs.some((verb) => title.startsWith(verb) || title.includes(` ${verb} `))) {
    score += 2;
    reasons.push('O título usa uma ação ampla ou genérica.');
  }
  if (!String(task.completionCriteria ?? '').trim()) {
    score += 2;
    reasons.push('Não possui critério de conclusão verificável.');
  }
  if (task.userDoesNotKnowHowToStart) {
    score += 3;
    reasons.push('Você indicou que não sabe por onde começar.');
  }

  let level = 'low';
  if (score >= 6) level = 'high';
  else if (score >= 3) level = 'medium';

  return { score, level, reasons };
}


const PROJECT_COLORS = new Set(['purple', 'blue', 'pink', 'green', 'yellow', 'orange']);
const VALID_STATUSES = new Set(Object.values(STATUS));

function cleanText(value, max, label, required = false) {
  const text = String(value ?? '').trim();
  if (required && !text) throw new Error(`${label} é obrigatório.`);
  if (text.length > max) throw new Error(`${label} deve ter no máximo ${max} caracteres.`);
  return text;
}

function cleanDate(value, label) {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T12:00:00Z`).getTime())) {
    throw new Error(`${label} inválida.`);
  }
  return text;
}

function cleanMinutes(value, label, nullable = false) {
  if ((value == null || value === '') && nullable) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 525600) {
    throw new Error(`${label} deve estar entre 1 minuto e 1 ano.`);
  }
  return number;
}

export function createProject(db, data) {
  const now = new Date().toISOString();
  const color = String(data.color || 'purple');
  if (!PROJECT_COLORS.has(color)) throw new Error('Cor de projeto inválida.');
  const project = {
    id: makeId(),
    name: cleanText(data.name, 80, 'Nome do projeto', true),
    description: cleanText(data.description, 2000, 'Descrição do projeto'),
    dueDate: cleanDate(data.dueDate, 'Data limite do projeto'),
    color,
    createdAt: now,
    updatedAt: now
  };
  db.projects.push(project);
  return project;
}

export function createTask(db, data) {
  const now = new Date().toISOString();
  const projectId = data.projectId ? String(data.projectId) : null;
  const parentId = data.parentId ? String(data.parentId) : null;
  const status = String(data.status || STATUS.PENDING);
  if (!VALID_STATUSES.has(status)) throw new Error('Status de tarefa inválido.');

  const tags = Array.isArray(data.tags)
    ? data.tags.map((tag) => cleanText(tag, 32, 'Tag')).filter(Boolean)
    : [];
  if (tags.length > 12) throw new Error('Uma tarefa pode ter no máximo 12 tags.');

  const task = {
    id: makeId(),
    projectId,
    parentId,
    name: cleanText(data.name, 120, 'Nome da tarefa', true),
    description: cleanText(data.description, 3000, 'Descrição da tarefa'),
    completionCriteria: cleanText(data.completionCriteria, 1000, 'Critério de conclusão'),
    dueDate: cleanDate(data.dueDate, 'Data limite da tarefa'),
    estimatedMinutes: cleanMinutes(data.estimatedMinutes, 'Tempo estimado', true),
    initialEstimateMinutes: data.initialEstimateMinutes == null
      ? cleanMinutes(data.estimatedMinutes, 'Estimativa inicial', true)
      : cleanMinutes(data.initialEstimateMinutes, 'Estimativa inicial', true),
    status,
    dependencyIds: Array.isArray(data.dependencyIds) ? [...new Set(data.dependencyIds.map(String))] : [],
    tags,
    userDoesNotKnowHowToStart: Boolean(data.userDoesNotKnowHowToStart),
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null
  };

  if (task.projectId && !getProject(db, task.projectId)) throw new Error('Projeto inválido.');
  if (task.parentId) {
    const parent = getTask(db, task.parentId);
    if (!parent || parent.projectId !== task.projectId) throw new Error('Tarefa-pai inválida.');
  }
  db.tasks.push(task);

  for (const dependencyId of task.dependencyIds) {
    const validation = validateDependency({ ...db, tasks: db.tasks.map((t) => t.id === task.id ? { ...t, dependencyIds: [] } : t) }, task.id, dependencyId);
    if (!validation.ok) {
      db.tasks = db.tasks.filter((item) => item.id !== task.id);
      throw new Error(validation.message);
    }
  }

  return task;
}

export function createTaskWithSteps(db, data, steps) {
  const initialEstimate = Number(data.initialEstimateMinutes ?? data.estimatedMinutes) || null;
  const parent = createTask(db, {
    ...data,
    estimatedMinutes: null,
    initialEstimateMinutes: initialEstimate,
    dependencyIds: []
  });

  const children = steps.map((step) => createTask(db, {
    projectId: parent.projectId,
    parentId: parent.id,
    name: step.name,
    description: step.description || '',
    completionCriteria: step.completionCriteria || '',
    dueDate: step.dueDate || null,
    estimatedMinutes: step.estimatedMinutes,
    tags: step.tags || []
  }));

  return { parent, children };
}

export function setTaskStatus(db, taskId, status) {
  const task = getTask(db, taskId);
  if (!task || isGroup(task, db.tasks)) return { ok: false, message: 'Somente tarefas executáveis podem mudar de status manualmente.' };
  if (status === STATUS.COMPLETED && isTaskBlocked(task, db.tasks)) {
    return { ok: false, message: 'Esta tarefa está bloqueada por pré-requisitos pendentes.' };
  }

  task.status = status;
  const now = new Date().toISOString();
  task.updatedAt = now;
  if (status === STATUS.IN_PROGRESS && !task.startedAt) task.startedAt = now;
  if (status === STATUS.COMPLETED) task.completedAt = now;
  if (status !== STATUS.COMPLETED) task.completedAt = null;
  return { ok: true, task };
}

export function updateTask(db, taskId, patch) {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, message: 'Tarefa não encontrada.' };

  const protectedKeys = new Set(['id', 'projectId', 'createdAt']);
  for (const [key, value] of Object.entries(patch)) {
    if (!protectedKeys.has(key)) task[key] = value;
  }
  task.updatedAt = new Date().toISOString();
  return { ok: true, task };
}

export function deleteTask(db, taskId) {
  const idsToDelete = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of db.tasks) {
      if (task.parentId && idsToDelete.has(task.parentId) && !idsToDelete.has(task.id)) {
        idsToDelete.add(task.id);
        changed = true;
      }
    }
  }

  db.tasks = db.tasks
    .filter((task) => !idsToDelete.has(task.id))
    .map((task) => ({
      ...task,
      dependencyIds: (task.dependencyIds ?? []).filter((id) => !idsToDelete.has(id))
    }));
  db.timerSessions = db.timerSessions.filter((session) => !idsToDelete.has(session.taskId));
  if (db.preferences.activeTimer && idsToDelete.has(db.preferences.activeTimer.taskId)) {
    db.preferences.activeTimer = null;
  }
  return idsToDelete;
}

export function deleteProject(db, projectId) {
  const taskIds = new Set(db.tasks.filter((task) => task.projectId === projectId).map((task) => task.id));
  db.projects = db.projects.filter((project) => project.id !== projectId);
  db.tasks = db.tasks.filter((task) => !taskIds.has(task.id));
  db.timerSessions = db.timerSessions.filter((session) => !taskIds.has(session.taskId));
  if (db.preferences.activeTimer && taskIds.has(db.preferences.activeTimer.taskId)) {
    db.preferences.activeTimer = null;
  }
}

export function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  if (!hours) return `${mins}min`;
  if (!mins) return `${hours}h`;
  return `${hours}h ${mins}min`;
}

export function priorityLabel(level) {
  return ({ low: 'Baixa', medium: 'Média', high: 'Alta', critical: 'Crítica' })[level] ?? level;
}

export function statusLabel(status) {
  return ({ pending: 'Pendente', in_progress: 'Em andamento', completed: 'Concluída' })[status] ?? status;
}

export function analyzeTaskGroup(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) return null;
  const leaves = getDescendantLeaves(taskId, db.tasks);
  const tempDb = { ...db, tasks: leaves.map((leaf) => ({ ...leaf, parentId: null })) };
  return analyzeProject(tempDb, task.projectId);
}
