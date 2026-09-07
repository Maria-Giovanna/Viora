import {
  analyzeProject,
  calculatePriority,
  getComputedStatus,
  getEffectiveDueDate,
  getProject,
  isTaskBlocked,
  priorityLabel,
  statusLabel
} from './engine.js';

const FIELD_ALIASES = new Map([
  ['status', 'status'],
  ['prioridade', 'priority'],
  ['priority', 'priority'],
  ['bloqueada', 'blocked'],
  ['bloqueado', 'blocked'],
  ['projeto', 'project'],
  ['project', 'project'],
  ['prazo', 'dueDate'],
  ['tag', 'tag'],
  ['nome', 'name']
]);

export function tokenize(input) {
  const tokens = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === '(' || char === ')' || char === ':') {
      tokens.push({ type: char, value: char });
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      i += 1;
      let value = '';
      while (i < input.length && input[i] !== quote) {
        value += input[i++];
      }
      if (input[i] !== quote) throw new Error('Aspas não fechadas no filtro.');
      i += 1;
      tokens.push({ type: 'WORD', value });
      continue;
    }

    let value = '';
    while (i < input.length && !/[\s():]/.test(input[i])) {
      value += input[i++];
    }
    const upper = value.toUpperCase();
    if (upper === 'E') tokens.push({ type: 'AND', value: 'E' });
    else if (upper === 'OU') tokens.push({ type: 'OR', value: 'OU' });
    else tokens.push({ type: 'WORD', value });
  }

  return tokens;
}

export function parseFilter(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const tokens = tokenize(trimmed);
  let index = 0;

  function peek(type) {
    return tokens[index]?.type === type;
  }

  function consume(type, message) {
    const token = tokens[index];
    if (!token || token.type !== type) throw new Error(message);
    index += 1;
    return token;
  }

  function parseCondition() {
    const field = consume('WORD', 'Esperado um campo, como status ou prioridade.').value.toLowerCase();
    consume(':', `Esperado ':' depois de ${field}.`);
    const value = consume('WORD', `Esperado um valor para ${field}.`).value;
    const canonicalField = FIELD_ALIASES.get(field);
    if (!canonicalField) throw new Error(`Campo desconhecido: ${field}.`);
    return { type: 'condition', field: canonicalField, value };
  }

  function parsePrimary() {
    if (peek('(')) {
      consume('(', 'Esperado (.');
      const expr = parseOr();
      consume(')', 'Falta fechar um parêntese no filtro.');
      return expr;
    }
    return parseCondition();
  }

  // E has precedence over OU.
  function parseAnd() {
    let left = parsePrimary();
    while (peek('AND')) {
      consume('AND', 'Operador E inválido.');
      left = { type: 'AND', left, right: parsePrimary() };
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek('OR')) {
      consume('OR', 'Operador OU inválido.');
      left = { type: 'OR', left, right: parseAnd() };
    }
    return left;
  }

  const tree = parseOr();
  if (index < tokens.length) {
    throw new Error(`Trecho inesperado no filtro: ${tokens[index].value}.`);
  }
  return tree;
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function matchesCondition(task, condition, db, analysisCache) {
  const expected = normalize(condition.value);
  let actual;

  switch (condition.field) {
    case 'status': {
      actual = normalize(statusLabel(getComputedStatus(task, db.tasks)));
      break;
    }
    case 'priority': {
      if (!analysisCache.has(task.projectId)) analysisCache.set(task.projectId, analyzeProject(db, task.projectId));
      const priority = calculatePriority(db, task, analysisCache.get(task.projectId));
      actual = normalize(priorityLabel(priority.level));
      break;
    }
    case 'blocked': {
      actual = isTaskBlocked(task, db.tasks) ? 'sim' : 'nao';
      break;
    }
    case 'project': {
      actual = normalize(getProject(db, task.projectId)?.name || 'avulsa');
      break;
    }
    case 'dueDate': {
      const dueDate = getEffectiveDueDate(task, db);
      if (expected === 'hoje') {
        const today = new Date().toISOString().slice(0, 10);
        return dueDate === today;
      }
      actual = normalize(dueDate);
      break;
    }
    case 'tag': {
      return (task.tags ?? []).some((tag) => normalize(tag) === expected);
    }
    case 'name': {
      actual = normalize(task.name);
      break;
    }
    default:
      return false;
  }

  return actual === expected;
}

export function evaluateFilter(task, tree, db, analysisCache = new Map()) {
  if (!tree) return true;
  if (tree.type === 'AND') {
    return evaluateFilter(task, tree.left, db, analysisCache) &&
      evaluateFilter(task, tree.right, db, analysisCache);
  }
  if (tree.type === 'OR') {
    return evaluateFilter(task, tree.left, db, analysisCache) ||
      evaluateFilter(task, tree.right, db, analysisCache);
  }
  if (tree.type === 'condition') return matchesCondition(task, tree, db, analysisCache);
  return false;
}

export function filterTasks(db, input, tasks = db.tasks) {
  const tree = parseFilter(input);
  if (!tree) return { tree: null, tasks };
  const analysisCache = new Map();
  return {
    tree,
    tasks: tasks.filter((task) => evaluateFilter(task, tree, db, analysisCache))
  };
}
