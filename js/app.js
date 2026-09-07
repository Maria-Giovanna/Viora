import { createEmptyDatabase, exportDatabase, importDatabase, loadDatabase, saveDatabase } from './db.js';
import { isSupabaseConfigured } from './supabase-client.js';
import { beginTotpEnrollment, changePassword, getMfaGate, getProfile, getSession, listMfaFactors, onAuthStateChange, requestAccountDeletion, requestPasswordReset, signIn, signOut, signUp, unenrollMfaFactor, updateProfile, updateRecoveredPassword, verifyMfaCode } from './auth.js';
import { mountCaptcha, requireCaptchaToken, resetCaptcha } from './captcha.js';
import {
  STATUS,
  addDependency,
  analyzeProject,
  analyzeTaskGroup,
  calculateDecomposition,
  calculateEffort,
  calculatePriority,
  calculateProgress,
  createProject,
  createTask,
  createTaskWithSteps,
  deleteProject,
  deleteTask,
  formatMinutes,
  getBlockingTasks,
  getChildren,
  getComputedStatus,
  getEffectiveDueDate,
  getProject,
  getProjectLeaves,
  getTask,
  isGroup,
  isTaskBlocked,
  priorityLabel,
  recommendTasks,
  removeDependency,
  setTaskStatus,
  statusLabel
} from './engine.js';
import { filterTasks } from './parser.js';
import {
  formatSeconds,
  getActiveElapsedSeconds,
  getTaskActualSeconds,
  pauseTimer,
  resumeTimer,
  startTimer,
  stopTimer
} from './timer.js';

let db = createEmptyDatabase();
let currentUser = null;
let currentProfile = null;
let activeUserLoad = null;
let mfaLoginFactorId = null;
let pendingMfaEnrollment = null;

const state = {
  view: 'now',
  selectedProjectId: null,
  filterQuery: '',
  dependencyTaskId: null,
  confirmAction: null,
  endedSessionTaskId: null,
  endedSessionDurationSeconds: 0
};

const viewEl = document.querySelector('#app-view');
const pageTitle = document.querySelector('#page-title');
const projectDialog = document.querySelector('#project-dialog');
const taskDialog = document.querySelector('#task-dialog');
const dependencyDialog = document.querySelector('#dependency-dialog');
const confirmDialog = document.querySelector('#confirm-dialog');
const sessionEndDialog = document.querySelector('#session-end-dialog');
const projectForm = document.querySelector('#project-form');
const taskForm = document.querySelector('#task-form');
const toastRegion = document.querySelector('#toast-region');
const authShell = document.querySelector('#auth-shell');
const appShell = document.querySelector('#app-shell');
const accountDialog = document.querySelector('#account-dialog');
const recoveryDialog = document.querySelector('#recovery-dialog');
const loginForm = document.querySelector('#login-form');
const signupForm = document.querySelector('#signup-form');
const forgotForm = document.querySelector('#forgot-form');
const profileForm = document.querySelector('#profile-form');
const changePasswordForm = document.querySelector('#change-password-form');
const recoveryForm = document.querySelector('#recovery-form');
const mfaLoginForm = document.querySelector('#mfa-login-form');
const mfaEnrollForm = document.querySelector('#mfa-enroll-form');
const syncStatus = document.querySelector('#sync-status');

function setSyncStatus(message, type = '') {
  if (!syncStatus) return;
  syncStatus.textContent = message;
  syncStatus.className = `sync-status ${type ? `is-${type}` : ''}`;
}

function persist() {
  if (!currentUser) return;
  db.preferences.activeProjectId = state.selectedProjectId;
  setSyncStatus('Salvando…', 'saving');
  saveDatabase(db, currentUser.id)
    .then(() => setSyncStatus(''))
    .catch((error) => {
      console.error('Falha ao salvar na nuvem:', error);
      setSyncStatus('Não foi possível salvar', 'error');
      showToast('Não foi possível sincronizar com a nuvem. Verifique sua conexão.', 'error');
    });
}

function setAuthView(view) {
  ['login', 'signup', 'forgot', 'mfa'].forEach((name) => {
    const element = document.querySelector(`#auth-view-${name}`);
    if (element) element.hidden = name !== view;
  });
}

function setFormMessage(id, message = '', success = false) {
  const element = document.querySelector(`#${id}`);
  if (!element) return;
  element.textContent = message;
  element.className = `auth-message ${success ? 'is-success' : ''}`;
}

function updateAccountUI() {
  const name = currentProfile?.display_name || currentUser?.user_metadata?.display_name || currentUser?.email?.split('@')[0] || 'Conta';
  document.querySelector('#user-display-name').textContent = name;
  document.querySelector('#user-email').textContent = currentUser?.email || '';
  document.querySelector('#user-avatar').textContent = name.trim().charAt(0).toUpperCase() || 'U';

  if (profileForm && currentUser) {
    profileForm.elements.displayName.value = name;
    profileForm.elements.email.value = currentUser.email || '';
  }
}

function isRetryableNetworkError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');

  return (
    name === 'AuthRetryableFetchError' ||
    /failed to fetch/i.test(message) ||
    /networkerror/i.test(message) ||
    /network error/i.test(message) ||
    /load failed/i.test(message) ||
    /timeout/i.test(message) ||
    /timed out/i.test(message)
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function enterAuthenticatedApp(user) {
  if (!user) return;
  if (activeUserLoad === user.id) return;

  activeUserLoad = user.id;
  setSyncStatus('');

  const maxAttempts = 3;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const gate = await getMfaGate();

        if (gate.requiresChallenge) {
          currentUser = user;
          currentProfile = null;
          mfaLoginFactorId = gate.verifiedFactors[0]?.id ?? null;

          appShell.hidden = true;
          authShell.hidden = false;

          setAuthView('mfa');
          setFormMessage('mfa-login-message');
          setSyncStatus('Segundo fator necessário');

          return;
        }

        const [loadedDb, profile] = await Promise.all([
          loadDatabase(user.id),
          getProfile(user.id)
        ]);

        currentUser = user;
        currentProfile = profile;
        db = loadedDb;

        state.selectedProjectId =
          db.preferences.activeProjectId ||
          db.projects[0]?.id ||
          null;

        updateAccountUI();

        setFormMessage('login-message');

        authShell.hidden = true;
        appShell.hidden = false;

        setSyncStatus('');

        render();
        return;

      } catch (error) {
        const isNetworkFailure =
          !navigator.onLine ||
          isRetryableNetworkError(error) ||
          error instanceof TypeError ||
          error?.status === 0;

        if (!isNetworkFailure || attempt === maxAttempts) {
          throw error;
        }

        console.warn(
          `Conexão instável. Nova tentativa ${attempt + 1}/${maxAttempts}.`,
          error
        );

        setFormMessage(
          'login-message',
          'Conexão instável. Tentando carregar seus dados novamente...'
        );

        await wait(1200 * attempt);
      }
    }

  } catch (error) {
    console.error(error);

    currentUser = null;
    currentProfile = null;

    appShell.hidden = true;
    authShell.hidden = false;

    setAuthView('login');

    const isNetworkFailure =
      !navigator.onLine ||
      isRetryableNetworkError(error) ||
      error instanceof TypeError ||
      error?.status === 0;

    if (isNetworkFailure) {
      setFormMessage(
        'login-message',
        'Não foi possível acessar seus dados. Verifique sua conexão e tente novamente.'
      );
    } else {
      setFormMessage(
        'login-message',
        'Não foi possível carregar seus dados. Tente novamente em alguns instantes.'
      );
    }

  } finally {
    activeUserLoad = null;
  }
}

function leaveAuthenticatedApp() {
  currentUser = null;
  currentProfile = null;
  db = createEmptyDatabase();
  state.selectedProjectId = null;
  state.filterQuery = '';
  state.dependencyTaskId = null;
  mfaLoginFactorId = null;
  pendingMfaEnrollment = null;
  appShell.hidden = true;
  authShell.hidden = false;
  setAuthView('login');
  setSyncStatus('Desconectado');
  renderTimerOverlay();
}

async function initializeAuthentication() {
  if (!isSupabaseConfigured) {
    document.querySelector('#auth-config-warning').hidden = false;
    authShell.hidden = false;
    appShell.hidden = true;
    for (const form of [loginForm, signupForm, forgotForm]) {
      form.querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
    }
    return;
  }

  await Promise.all([
    mountCaptcha('login', 'captcha-login'),
    mountCaptcha('signup', 'captcha-signup'),
    mountCaptcha('forgot', 'captcha-forgot')
  ]).catch((error) => console.warn('CAPTCHA indisponível:', error));

  onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      authShell.hidden = true;
      appShell.hidden = true;
      recoveryDialog.showModal();
      return;
    }
    if (event === 'SIGNED_OUT') {
      leaveAuthenticatedApp();
      return;
    }
    if (session?.user && ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED', 'INITIAL_SESSION'].includes(event)) {
      enterAuthenticatedApp(session.user);
    }
  });

  try {
    const session = await getSession();
    if (session?.user) await enterAuthenticatedApp(session.user);
    else leaveAuthenticatedApp();
  } catch (error) {
    console.error(error);
    leaveAuthenticatedApp();
    setFormMessage('login-message', 'Não foi possível conectar ao serviço de autenticação.');
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function icon(name, className = 'icon') {
  return `<span class="${className} icon-${name}" aria-hidden="true"></span>`;
}

function colorValue(name) {
  return ({
    purple: '#e6ddf7',
    blue: '#dceaff',
    pink: '#f7dce8',
    green: '#ddf1e3',
    yellow: '#fff0bc',
    orange: '#fbe1c8'
  })[name] || '#e6ddf7';
}

function dueLabel(date) {
  if (!date) return 'Sem prazo';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(`${date}T12:00:00`));
}

function projectProgress(projectId) {
  const leaves = getProjectLeaves(projectId, db.tasks);
  if (!leaves.length) return 0;
  return Math.round(leaves.filter((task) => task.status === STATUS.COMPLETED).length / leaves.length * 100);
}

function projectTaskCounts(projectId) {
  const leaves = getProjectLeaves(projectId, db.tasks);
  return {
    total: leaves.length,
    completed: leaves.filter((task) => task.status === STATUS.COMPLETED).length,
    blocked: leaves.filter((task) => isTaskBlocked(task, db.tasks) && task.status !== STATUS.COMPLETED).length,
    available: leaves.filter((task) => !isTaskBlocked(task, db.tasks) && task.status !== STATUS.COMPLETED).length
  };
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type ? `is-${type}` : ''}`;
  toast.textContent = message;
  toastRegion.appendChild(toast);
  setTimeout(() => toast.remove(), 3600);
}

function formatPriority(level) {
  return `<span class="pill pill-${level}">${escapeHtml(priorityLabel(level))}</span>`;
}

function ensureTimerOverlayRoot() {
  let root = document.querySelector('#timer-overlay-root');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'timer-overlay-root';
  root.className = 'timer-overlay-root';
  root.hidden = true;
  document.body.appendChild(root);
  return root;
}

function renderTimerOverlay() {
  const root = ensureTimerOverlayRoot();
  const active = currentUser ? db.preferences.activeTimer : null;
  const task = active ? getTask(db, active.taskId) : null;

  if (!active || !task) {
    root.hidden = true;
    root.replaceChildren();
    document.body.classList.remove('has-active-timer');
    return;
  }

  root.hidden = false;
  document.body.classList.add('has-active-timer');
  root.innerHTML = `
    <aside class="timer-overlay ${active.isPaused ? 'is-paused' : ''}" aria-label="Cronômetro da tarefa ${escapeHtml(task.name)}">
      <div class="timer-overlay-main">
        <div class="timer-overlay-copy">
          <span class="timer-overlay-status">${icon(active.isPaused ? 'pause' : 'clock', 'icon icon-sm')}${active.isPaused ? 'Sessão pausada' : 'Em andamento'}</span>
          <strong class="timer-overlay-task" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</strong>
        </div>
        <span class="timer-overlay-clock" id="active-timer-clock">${formatSeconds(getActiveElapsedSeconds(db))}</span>
      </div>
      <div class="timer-overlay-actions">
        <button class="small-button" data-action="${active.isPaused ? 'resume-timer' : 'pause-timer'}">${icon(active.isPaused ? 'play' : 'pause', 'icon icon-sm')}${active.isPaused ? 'Retomar' : 'Pausar'}</button>
        <button class="small-button timer-overlay-stop" data-action="stop-timer">${icon('check', 'icon icon-sm')}Encerrar sessão</button>
      </div>
    </aside>`;
}

function render() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.view === state.view);
  });

  const titles = { now: 'Agora', projects: 'Projetos', tasks: 'Tarefas', planning: 'Planejamento' };
  pageTitle.textContent = titles[state.view];

  if (state.view === 'now') renderNow();
  else if (state.view === 'projects') renderProjects();
  else if (state.view === 'tasks') renderTasks();
  else renderPlanning();

  renderTimerOverlay();
}

function renderEmptyApp() {
  return `
    <div class="card empty-state">
      <div class="empty-art" aria-hidden="true">${icon('arrow-right', 'icon icon-lg')}</div>
      <h2>Comece do jeito que fizer sentido</h2>
      <p>Você pode registrar uma tarefa avulsa imediatamente ou criar um projeto para agrupar várias etapas. Projetos ajudam no Gantt e no caminho crítico, mas não são obrigatórios para capturar uma tarefa.</p>
      <div class="empty-actions">
        <button class="button button-primary" data-action="open-task-dialog">${icon('plus')}Criar tarefa</button>
        <button class="button button-secondary" data-action="open-project-dialog">${icon('projects')}Criar projeto</button>
        <button class="button button-ghost" data-action="load-demo">${icon('planning')}Cenário de avaliação</button>
      </div>
    </div>`;
}

function renderNow() {
  if (!db.tasks.length && !db.projects.length) {
    viewEl.innerHTML = renderEmptyApp();
    return;
  }

  const availableMinutes = db.preferences.lastAvailableMinutes;
  const recommendations = recommendTasks(db, availableMinutes);
  const allLeaves = db.tasks.filter((task) => !isGroup(task, db.tasks));
  const pending = allLeaves.filter((task) => task.status !== STATUS.COMPLETED);
  const blocked = pending.filter((task) => isTaskBlocked(task, db.tasks));
  const available = pending.filter((task) => !isTaskBlocked(task, db.tasks));
  const timeOptions = [15, 30, 45, 60, 120];

  viewEl.innerHTML = `
    <div class="hero-card">
      <div>
        <p class="eyebrow">Decisão reduzida</p>
        <h2>${availableMinutes ? `Você tem ${formatMinutes(availableMinutes)}. O que cabe agora?` : 'O que faz mais sentido fazer agora?'}</h2>
        <p>O sistema cruza prazo, caminho crítico, folga, impacto de desbloqueio e dependências. Se você informar quanto tempo tem, ele também filtra o que cabe nesta sessão.</p>
      </div>
      <div>
        <p><strong>Quanto tempo você tem?</strong></p>
        <div class="time-picker">
          <button class="time-chip ${availableMinutes == null ? 'is-active' : ''}" data-time="none">Sem limite</button>
          ${timeOptions.map((m) => `<button class="time-chip ${availableMinutes === m ? 'is-active' : ''}" data-time="${m}">${formatMinutes(m)}</button>`).join('')}
          <button class="time-chip" data-action="custom-time">Outro</button>
        </div>
      </div>
    </div>

    <div class="grid grid-3 section">
      <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('check', 'icon icon-sm')}</span>Disponíveis agora</span><strong>${available.length}</strong></div>
      <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('lock', 'icon icon-sm')}</span>Bloqueadas</span><strong>${blocked.length}</strong></div>
      <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('tasks', 'icon icon-sm')}</span>Pendentes</span><strong>${pending.length}</strong></div>
    </div>

    <section class="section">
      <div class="section-header">
        <div><h2>Recomendadas</h2><p>Ordenadas pelo impacto estrutural e pelo tempo disponível.</p></div>
      </div>
      ${recommendations.length ? `<div class="task-tree">${recommendations.map(({ task }) => renderTaskCard(task, 0, true)).join('')}</div>` : `
        <div class="card empty-state">
          <h3>Nenhuma tarefa cabe nesse intervalo</h3>
          <p>Você pode aumentar o tempo disponível ou abrir a lista de tarefas para escolher manualmente.</p>
        </div>`}
    </section>

    ${blocked.length ? `
      <section class="section">
        <div class="section-header"><div><h2>Bloqueadas relevantes</h2><p>Você não precisa agir nelas até os pré-requisitos terminarem.</p></div></div>
        <div class="task-tree">${blocked.slice(0, 5).map((task) => renderTaskCard(task, 0)).join('')}</div>
      </section>` : ''}
  `;
}

function renderProjects() {
  if (!db.projects.length) {
    const standaloneCount = getProjectLeaves(null, db.tasks).length;
    viewEl.innerHTML = `
      <div class="card empty-state">
        <div class="empty-art" aria-hidden="true">${icon('projects', 'icon icon-lg')}</div>
        <h2>Nenhum projeto criado ainda</h2>
        <p>Você pode continuar usando ${standaloneCount ? `${standaloneCount} tarefa(s) avulsa(s)` : 'tarefas avulsas'} normalmente. Crie um projeto quando quiser agrupar um objetivo maior, acompanhar progresso e visualizar um Gantt específico.</p>
        <div class="empty-actions">
          <button class="button button-secondary" data-action="open-project-dialog">${icon('plus')}Criar projeto</button>
          <button class="button button-ghost" data-action="open-task-dialog">${icon('tasks')}Criar tarefa avulsa</button>
        </div>
      </div>`;
    return;
  }

  if (!state.selectedProjectId || !getProject(db, state.selectedProjectId)) {
    state.selectedProjectId = db.projects[0].id;
  }

  const cards = db.projects.map((project) => {
    const analysis = analyzeProject(db, project.id);
    const counts = projectTaskCounts(project.id);
    const progress = projectProgress(project.id);
    return `
      <article class="card project-card" style="--accent:${colorValue(project.color)}">
        <div class="project-top">
          <div>
            <h3>${escapeHtml(project.name)}</h3>
            <p>${escapeHtml(project.description || 'Sem descrição')}</p>
          </div>
          <button class="small-button" data-action="select-project" data-project-id="${project.id}">Abrir${icon('arrow-right', 'icon icon-sm')}</button>
        </div>
        <div class="progress-track" aria-label="${progress}% concluído"><div class="progress-bar" style="width:${progress}%"></div></div>
        <div class="meta-row">
          <span>${progress}% concluído</span>
          <span>${counts.total} tarefa(s)</span>
          <span>${formatMinutes(analysis.effortMinutes)} de trabalho</span>
          <span>${dueLabel(project.dueDate)}</span>
        </div>
      </article>`;
  }).join('');

  const project = getProject(db, state.selectedProjectId);
  const roots = db.tasks.filter((task) => task.projectId === project.id && !task.parentId);
  const analysis = analyzeProject(db, project.id);
  const counts = projectTaskCounts(project.id);

  viewEl.innerHTML = `
    <div class="grid grid-2">${cards}</div>
    <section class="section">
      <div class="section-header">
        <div>
          <p class="eyebrow">Projeto selecionado</p>
          <h2>${escapeHtml(project.name)}</h2>
          <p>Trabalho total e duração estrutural são valores diferentes.</p>
        </div>
        <button class="button button-danger" data-action="delete-project" data-project-id="${project.id}">${icon('trash')}Excluir projeto</button>
      </div>
      <div class="grid grid-4">
        <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('clock', 'icon icon-sm')}</span>Esforço total</span><strong>${formatMinutes(analysis.effortMinutes)}</strong></div>
        <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('planning', 'icon icon-sm')}</span>Duração projetada</span><strong>${formatMinutes(analysis.projectedDurationMinutes)}</strong></div>
        <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('check', 'icon icon-sm')}</span>Disponíveis</span><strong>${counts.available}</strong></div>
        <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('lock', 'icon icon-sm')}</span>Bloqueadas</span><strong>${counts.blocked}</strong></div>
      </div>
    </section>

    <section class="section">
      <div class="section-header"><div><h2>Estrutura do projeto</h2><p>Pais são concluídos automaticamente a partir das tarefas executáveis.</p></div></div>
      ${roots.length ? `<div class="task-tree">${roots.map((task) => renderTaskBranch(task, 0)).join('')}</div>` : `
        <div class="card empty-state"><h3>Nenhuma tarefa ainda</h3><p>Crie uma tarefa unitária ou divida um objetivo em etapas menores.</p><button class="button button-primary" data-action="open-task-dialog">${icon('plus')}Criar tarefa</button></div>`}
    </section>
  `;
}

function renderTaskBranch(task, depth) {
  const children = getChildren(db.tasks, task.id);
  return `<div class="task-node" style="--depth:${depth}">${renderTaskCard(task, depth)}${children.map((child) => renderTaskBranch(child, depth + 1)).join('')}</div>`;
}

function renderTaskCard(task, depth = 0, compact = false) {
  const group = isGroup(task, db.tasks);
  const blocked = !group && isTaskBlocked(task, db.tasks);
  const status = getComputedStatus(task, db.tasks);
  const project = getProject(db, task.projectId);
  const effectiveDue = getEffectiveDueDate(task, db);
  const actual = getTaskActualSeconds(db, task.id);
  let details = '';
  let badges = '';

  if (group) {
    const scope = analyzeTaskGroup(db, task.id);
    const progress = calculateProgress(task.id, db.tasks);
    details = `${progress}% concluído · ${formatMinutes(calculateEffort(task.id, db.tasks))} de trabalho · ${formatMinutes(scope?.projectedDurationMinutes || 0)} projetadas`;
    badges = `<span class="pill pill-success">${icon('subtask', 'icon icon-sm')}Agrupador</span>`;
  } else {
    const analysis = analyzeProject(db, task.projectId);
    const priority = calculatePriority(db, task, analysis);
    const blocking = getBlockingTasks(task, db.tasks);
    badges = `${formatPriority(priority.level)} ${blocked ? `<span class="pill pill-blocked">${icon('lock', 'icon icon-sm')}Bloqueada</span>` : `<span class="pill pill-success">${icon('check', 'icon icon-sm')}Disponível</span>`}`;
    details = `${formatMinutes(task.estimatedMinutes)} estimados · ${dueLabel(effectiveDue)}${actual ? ` · ${formatSeconds(actual)} reais` : ''}`;
    if (blocking.length) details += ` · aguardando ${blocking.map((item) => item.name).join(', ')}`;
  }

  const classes = ['task-card'];
  if (group) classes.push('is-group');
  if (blocked) classes.push('is-blocked');
  if (status === STATUS.COMPLETED) classes.push('is-completed');

  return `
    <article class="${classes.join(' ')}" ${blocked ? `title="Aguardando pré-requisitos: ${escapeHtml(getBlockingTasks(task, db.tasks).map((item) => item.name).join(', '))}"` : ''}>
      <div>
        ${group ? `<span class="group-icon" aria-hidden="true">${icon('subtask', 'icon')}</span>` : `<input class="task-check" type="checkbox" data-action="toggle-task" data-task-id="${task.id}" ${status === STATUS.COMPLETED ? 'checked' : ''} ${blocked ? 'disabled' : ''} aria-label="Marcar ${escapeHtml(task.name)} como concluída" />`}
      </div>
      <div>
        <div class="task-title-row">
          <span class="task-title">${escapeHtml(task.name)}</span>
          ${badges}
        </div>
        <div class="task-subtitle">${escapeHtml(project?.name || 'Tarefa avulsa')} · ${escapeHtml(details)}</div>
        ${!group && task.completionCriteria && !compact ? `<div class="task-subtitle">Concluída quando: ${escapeHtml(task.completionCriteria)}</div>` : ''}
      </div>
      <div class="task-actions">
        ${!group ? `<button class="small-button" data-action="manage-dependencies" data-task-id="${task.id}">${icon('link', 'icon icon-sm')}Dependências</button>` : ''}
        ${!group && status !== STATUS.COMPLETED ? `<button class="small-button" data-action="start-task" data-task-id="${task.id}" ${blocked ? 'disabled' : ''}>${icon('play', 'icon icon-sm')}Iniciar</button>` : ''}
        ${!compact ? `<button class="small-button" data-action="delete-task" data-task-id="${task.id}">${icon('trash', 'icon icon-sm')}Excluir</button>` : ''}
      </div>
    </article>`;
}

function renderTasks() {
  viewEl.innerHTML = `
    <div class="card">
      <div class="filter-bar">
        <input id="logical-filter" class="filter-input" value="${escapeHtml(state.filterQuery)}" placeholder="status:pendente E prioridade:alta" aria-label="Filtro lógico de tarefas" />
        <button class="button button-ghost" data-action="clear-filter">${icon('x')}Limpar</button>
      </div>
      <p class="filter-help">Use campos como <span class="code-inline">status</span>, <span class="code-inline">prioridade</span>, <span class="code-inline">bloqueada</span>, <span class="code-inline">projeto</span>, <span class="code-inline">prazo</span> e operadores <strong>E / OU</strong>. Parênteses também são aceitos.</p>
      <div id="filter-error"></div>
    </div>
    <section class="section">
      <div class="section-header"><div><h2>Resultado</h2><p id="filter-count"></p></div></div>
      <div id="filtered-task-list" class="task-tree"></div>
    </section>`;
  updateTaskFilterResults();
}

function updateTaskFilterResults() {
  const list = document.querySelector('#filtered-task-list');
  const error = document.querySelector('#filter-error');
  const count = document.querySelector('#filter-count');
  if (!list) return;

  try {
    const result = filterTasks(db, state.filterQuery, db.tasks);
    error.innerHTML = '';
    count.textContent = `${result.tasks.length} item(ns) encontrado(s)`;
    list.innerHTML = result.tasks.length
      ? result.tasks.map((task) => renderTaskCard(task)).join('')
      : `<div class="card empty-state"><h3>Nenhum resultado</h3><p>O filtro foi interpretado corretamente, mas nenhuma tarefa atende a todas as condições.</p></div>`;
  } catch (err) {
    error.innerHTML = `<p class="filter-error">${escapeHtml(err.message)}</p>`;
    count.textContent = 'Consulta inválida';
    list.innerHTML = '';
  }
}

function renderPlanning() {
  const standaloneLeaves = getProjectLeaves(null, db.tasks);
  const hasStandalone = standaloneLeaves.length > 0;

  if (!db.projects.length && !hasStandalone) {
    viewEl.innerHTML = renderEmptyApp();
    return;
  }

  const selectedProject = getProject(db, state.selectedProjectId);
  let scopeId;
  if (selectedProject) scopeId = selectedProject.id;
  else if (state.selectedProjectId === null && hasStandalone) scopeId = null;
  else scopeId = db.projects[0]?.id ?? null;

  state.selectedProjectId = scopeId;
  const project = getProject(db, scopeId);
  const analysis = analyzeProject(db, scopeId);
  const leaves = getProjectLeaves(scopeId, db.tasks);
  const pathNames = analysis.criticalPathIds.map((id) => getTask(db, id)?.name).filter(Boolean);
  const scopeLabel = project?.name || 'Tarefas avulsas';

  const options = [
    ...(hasStandalone ? [`<option value="__standalone__" ${scopeId === null ? 'selected' : ''}>Tarefas avulsas</option>`] : []),
    ...db.projects.map((p) => `<option value="${p.id}" ${p.id === scopeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
  ].join('');

  viewEl.innerHTML = `
    <div class="card planning-scope-card">
      <label class="field" style="margin:0;max-width:460px">
        <span>Contexto analisado</span>
        <select id="planning-project">${options}</select>
      </label>
      <p class="helper">O caminho crítico é calculado dentro de um mesmo contexto. Tarefas avulsas podem formar sua própria cadeia de dependências.</p>
    </div>

    <div class="grid grid-3 section">
      <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('clock', 'icon icon-sm')}</span>Esforço total</span><strong>${formatMinutes(analysis.effortMinutes)}</strong></div>
      <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('planning', 'icon icon-sm')}</span>Duração estrutural</span><strong>${formatMinutes(analysis.projectedDurationMinutes)}</strong></div>
      <div class="card metric-card"><span class="metric-label"><span class="metric-icon">${icon('tasks', 'icon icon-sm')}</span>Tarefas críticas</span><strong>${analysis.criticalTaskIds.size}</strong></div>
    </div>

    <section class="section">
      <div class="card">
        <p class="eyebrow">Caminho crítico · ${escapeHtml(scopeLabel)}</p>
        <h2>${pathNames.length ? pathNames.map(escapeHtml).join(' → ') : 'Ainda não calculável'}</h2>
        <p>${pathNames.length ? 'Qualquer atraso sem folga nessa sequência pode aumentar a duração estrutural deste contexto.' : 'Adicione tarefas executáveis com estimativa de tempo.'}</p>
      </div>
    </section>

    <section class="section">
      <div class="section-header"><div><h2>Gráfico de Gantt</h2><p>As barras usam o início mais cedo calculado pelo grafo. Roxo indica tarefa crítica.</p></div></div>
      ${renderGantt(leaves, analysis)}
    </section>
  `;
}

function renderGantt(leaves, analysis) {
  if (!leaves.length || !analysis.projectedDurationMinutes) {
    return `<div class="card empty-state"><h3>Sem dados para o Gantt</h3><p>Crie tarefas executáveis e informe suas durações.</p></div>`;
  }
  const total = analysis.projectedDurationMinutes;
  const ordered = [...leaves].sort((a, b) => (analysis.earliestStart.get(a.id) ?? 0) - (analysis.earliestStart.get(b.id) ?? 0));
  const ticks = Array.from({ length: 6 }, (_, i) => Math.round(total * i / 5));

  return `
    <div class="card gantt-wrapper">
      <div class="gantt">
        <div class="gantt-header">
          <div class="gantt-label"><strong>Tarefa</strong></div>
          <div class="gantt-scale">${ticks.map((tick) => `<span>${formatMinutes(tick)}</span>`).join('')}</div>
        </div>
        ${ordered.map((task) => {
          const start = analysis.earliestStart.get(task.id) ?? 0;
          const duration = Number(task.estimatedMinutes) || 0;
          const left = total ? start / total * 100 : 0;
          const width = total ? duration / total * 100 : 0;
          const critical = analysis.criticalTaskIds.has(task.id);
          return `
            <div class="gantt-row">
              <div class="gantt-label" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</div>
              <div class="gantt-track" aria-label="${escapeHtml(task.name)} começa em ${formatMinutes(start)} e dura ${formatMinutes(duration)}">
                <div class="gantt-bar ${critical ? 'is-critical' : ''}" style="left:${left}%;width:${Math.max(width, 1)}%" title="${formatMinutes(start)} → ${formatMinutes(start + duration)}"></div>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function openProjectDialog() {
  projectForm.reset();
  projectDialog.showModal();
  projectForm.elements.name.focus();
}

function populateTaskProjectSelect() {
  const select = document.querySelector('#task-project');
  select.replaceChildren();

  const standalone = document.createElement('option');
  standalone.value = '';
  standalone.textContent = 'Sem projeto — tarefa avulsa';
  standalone.selected = !state.selectedProjectId;
  select.appendChild(standalone);

  for (const project of db.projects) {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name;
    option.selected = project.id === state.selectedProjectId;
    select.appendChild(option);
  }
}

function renderDependencyOptions(projectId) {
  const scopeId = projectId || null;
  const container = document.querySelector('#dependency-options');
  if (!container) return;
  container.replaceChildren();
  const leaves = getProjectLeaves(scopeId, db.tasks);
  if (!leaves.length) {
    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent = scopeId ? 'Ainda não há tarefas existentes neste projeto. Você pode criar um novo pré-requisito abaixo.' : 'Ainda não há outras tarefas avulsas. Você pode criar um novo pré-requisito abaixo.';
    container.appendChild(helper);
    return;
  }
  for (const task of leaves) {
    const label = document.createElement('label');
    label.className = 'dependency-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'dependencyIds';
    input.value = task.id;
    const span = document.createElement('span');
    span.textContent = task.name;
    label.append(input, span);
    container.appendChild(label);
  }
}

function resetSteps() {
  const list = document.querySelector('#steps-list');
  list.replaceChildren();
  addStepRow();
  addStepRow();
}

function addStepRow(values = {}) {
  const list = document.querySelector('#steps-list');
  const row = document.createElement('div');
  row.className = 'step-row';

  const name = document.createElement('input');
  name.className = 'step-name';
  name.placeholder = 'Nome da etapa';
  name.value = String(values.name || '').slice(0, 120);
  name.maxLength = 120;
  name.setAttribute('aria-label', 'Nome da etapa');

  const hours = document.createElement('input');
  hours.className = 'step-hours';
  hours.type = 'number';
  hours.min = '0';
  hours.value = Number(values.hours ?? 1);
  hours.setAttribute('aria-label', 'Horas da etapa');

  const minutes = document.createElement('input');
  minutes.className = 'step-minutes';
  minutes.type = 'number';
  minutes.min = '0';
  minutes.max = '59';
  minutes.value = Number(values.minutes ?? 0);
  minutes.setAttribute('aria-label', 'Minutos da etapa');

  const criteria = document.createElement('input');
  criteria.className = 'step-criteria';
  criteria.placeholder = 'Concluída quando...';
  criteria.value = String(values.criteria || '').slice(0, 1000);
  criteria.maxLength = 1000;
  criteria.setAttribute('aria-label', 'Critério de conclusão da etapa');

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'small-button';
  remove.dataset.action = 'remove-step';
  remove.setAttribute('aria-label', 'Remover etapa');
  remove.textContent = '×';

  row.append(name, hours, minutes, criteria, remove);
  list.appendChild(row);
}

function openTaskDialog() {
  taskForm.reset();
  populateTaskProjectSelect();
  document.querySelector('#unit-task-fields').hidden = false;
  document.querySelector('#steps-fields').hidden = true;
  document.querySelector('#new-prerequisite-fields').hidden = true;
  document.querySelector('#decomposition-hint').hidden = true;
  resetSteps();
  renderDependencyOptions(document.querySelector('#task-project').value);
  taskDialog.showModal();
  taskForm.elements.name.focus();
}

function getMinutes(hours, minutes) {
  return Math.max(0, (Number(hours) || 0) * 60 + (Number(minutes) || 0));
}

function updateDecompositionHint() {
  if (taskForm.elements.hasSteps.value === 'yes') return;
  const estimatedMinutes = getMinutes(taskForm.elements.hours.value, taskForm.elements.minutes.value);
  const probe = {
    name: taskForm.elements.name.value,
    estimatedMinutes,
    completionCriteria: taskForm.elements.completionCriteria.value,
    userDoesNotKnowHowToStart: taskForm.elements.doesNotKnowHowToStart.checked
  };
  const result = calculateDecomposition(probe);
  const hint = document.querySelector('#decomposition-hint');
  hint.replaceChildren();
  if (result.level === 'low') {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  const strong = document.createElement('strong');
  strong.textContent = result.level === 'high' ? 'Recomendamos dividir esta tarefa.' : 'Talvez valha dividir esta tarefa.';
  const reason = document.createElement('span');
  reason.textContent = ` ${result.reasons.join(' ')}`;
  hint.append(strong, document.createElement('br'), reason);
}

function openDependencyManager(taskId) {
  state.dependencyTaskId = taskId;
  const task = getTask(db, taskId);
  document.querySelector('#dependency-task-title').textContent = task?.name || 'Dependências';
  renderDependencyManager();
  dependencyDialog.showModal();
}

function renderDependencyManager(message = '') {
  const container = document.querySelector('#dependency-manager');
  const task = getTask(db, state.dependencyTaskId);
  if (!task) return;
  const current = (task.dependencyIds ?? []).map((id) => getTask(db, id)).filter(Boolean);
  const candidates = getProjectLeaves(task.projectId, db.tasks).filter((candidate) => candidate.id !== task.id && !task.dependencyIds.includes(candidate.id));

  container.innerHTML = `
    ${message ? `<div class="notice ${message.startsWith('Erro:') ? 'notice-danger' : 'notice-success'}">${escapeHtml(message.replace(/^Erro:\s*/, ''))}</div>` : ''}
    <div class="subsection">
      <div class="subsection-title"><div><strong>Pré-requisitos atuais</strong><p>A tarefa só fica disponível quando todos estiverem concluídos.</p></div></div>
      <div class="dependency-list">
        ${current.length ? current.map((dep) => `<div class="dependency-item"><span>${escapeHtml(dep.name)}</span><button class="small-button" data-action="remove-dependency" data-dependency-id="${dep.id}">${icon('x', 'icon icon-sm')}Remover</button></div>`).join('') : '<p class="helper">Nenhum pré-requisito. A tarefa está estruturalmente livre para começar.</p>'}
      </div>
    </div>

    <div class="subsection">
      <strong>Adicionar tarefa existente</strong>
      <div class="field-grid" style="margin-top:10px">
        <label class="field"><span>Tarefa</span><select id="dependency-candidate"><option value="">Selecione...</option>${candidates.map((candidate) => `<option value="${candidate.id}">${escapeHtml(candidate.name)}</option>`).join('')}</select></label>
        <div style="display:flex;align-items:end;margin-bottom:14px"><button class="button button-secondary" data-action="add-dependency">${icon('link')}Adicionar pré-requisito</button></div>
      </div>
    </div>

    <div class="subsection">
      <strong>O pré-requisito ainda não existe?</strong>
      <p class="helper">Crie uma tarefa real agora; ela receberá um ID e será ligada a esta tarefa.</p>
      <div class="field-grid">
        <label class="field"><span>Nome</span><input id="quick-prereq-name" placeholder="Ex.: Estudar DOM" /></label>
        <label class="field"><span>Concluída quando...</span><input id="quick-prereq-criteria" placeholder="Ex.: exercício final concluído" /></label>
      </div>
      <div class="field-grid">
        <label class="field"><span>Horas</span><input id="quick-prereq-hours" type="number" min="0" value="1" /></label>
        <label class="field"><span>Minutos</span><input id="quick-prereq-minutes" type="number" min="0" max="59" value="0" /></label>
      </div>
      <button class="button button-ghost" data-action="create-quick-prerequisite">${icon('plus')}Criar e vincular</button>
    </div>
  `;
}

function askConfirm(title, message, action) {
  state.confirmAction = action;
  document.querySelector('#confirm-title').textContent = title;
  document.querySelector('#confirm-message').textContent = message;
  confirmDialog.showModal();
}

function clearEndedSessionState() {
  state.endedSessionTaskId = null;
  state.endedSessionDurationSeconds = 0;
}

function openSessionEndDialog(taskId, durationSeconds) {
  const task = getTask(db, taskId);
  if (!task) return;

  state.endedSessionTaskId = taskId;
  state.endedSessionDurationSeconds = durationSeconds;
  document.querySelector('#session-duration').textContent = formatSeconds(durationSeconds);
  document.querySelector('#session-task-name').textContent = task.name;
  document.querySelector('#session-completion-criterion').textContent = task.completionCriteria?.trim() || 'Você não definiu um critério específico. Confirme apenas se considera a tarefa realmente concluída.';
  sessionEndDialog.showModal();
}

function keepTaskInProgressAfterSession() {
  const task = getTask(db, state.endedSessionTaskId);
  sessionEndDialog.close();
  clearEndedSessionState();
  showToast(task ? `Sessão registrada. “${task.name}” continua em andamento.` : 'Sessão registrada. A tarefa continua em andamento.', 'success');
  render();
}

function completeTaskAfterSession() {
  const taskId = state.endedSessionTaskId;
  const task = getTask(db, taskId);
  if (!task) {
    sessionEndDialog.close();
    clearEndedSessionState();
    return;
  }

  const result = setTaskStatus(db, taskId, STATUS.COMPLETED);
  if (!result.ok) {
    showToast(result.message, 'error');
    return;
  }

  sessionEndDialog.close();
  clearEndedSessionState();
  persist();
  render();
  showToast('Tarefa concluída. Dependências, prioridades e planejamento foram recalculados.', 'success');
}

function handleTaskToggle(taskId, checked) {
  const result = setTaskStatus(db, taskId, checked ? STATUS.COMPLETED : STATUS.PENDING);
  if (!result.ok) {
    showToast(result.message, 'error');
    render();
    return;
  }
  persist();
  showToast(checked ? 'Tarefa concluída. Dependências e prioridades foram recalculadas.' : 'Tarefa reaberta.', 'success');
  render();
}

function startTask(taskId) {
  const task = getTask(db, taskId);
  if (!task || isTaskBlocked(task, db.tasks)) {
    showToast('Essa tarefa ainda está bloqueada.', 'error');
    return;
  }
  try {
    startTimer(db, taskId);
    if (task.status === STATUS.PENDING) setTaskStatus(db, taskId, STATUS.IN_PROGRESS);
    persist();
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function loadDemo() {
  db = {
    schemaVersion: 1,
    projects: [], tasks: [], timerSessions: [],
    preferences: { lastAvailableMinutes: 60, activeTimer: null, activeProjectId: null }
  };
  const project = createProject(db, { name: 'Cenário de avaliação', description: 'Dados prontos para validar anti-loop, caminho crítico e filtros.', dueDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), color: 'purple' });
  const a = createTask(db, { projectId: project.id, name: 'Tarefa 1', estimatedMinutes: 300, completionCriteria: 'Etapa concluída' });
  const b = createTask(db, { projectId: project.id, name: 'Tarefa 2', estimatedMinutes: 300, completionCriteria: 'Etapa concluída', dependencyIds: [a.id] });
  createTask(db, { projectId: project.id, name: 'Tarefa 3', estimatedMinutes: 120, completionCriteria: 'Etapa concluída', dependencyIds: [b.id] });
  createTask(db, { projectId: project.id, name: 'Tarefa paralela', estimatedMinutes: 180, completionCriteria: 'Etapa concluída', dueDate: new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10) });
  state.selectedProjectId = project.id;
  persist();
  showToast('Cenário de avaliação carregado.', 'success');
  render();
}


loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormMessage('login-message');

  const submit = loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;

  try {
    const captchaToken = requireCaptchaToken('login');

    await signIn(
      loginForm.elements.email.value,
      loginForm.elements.password.value,
      captchaToken
    );

  } catch (error) {
    console.warn('Falha de autenticação:', error);

    const isNetworkFailure =
      !navigator.onLine ||
      isRetryableNetworkError(error) ||
      error instanceof TypeError ||
      error?.status === 0;

    const isInvalidCredentials =
      error?.code === 'invalid_credentials' ||
      /invalid login credentials/i.test(String(error?.message || ''));

    if (isNetworkFailure) {
      setFormMessage(
        'login-message',
        'Sem conexão com a internet. Verifique sua rede e tente novamente.'
      );

    } else if (isInvalidCredentials) {
      setFormMessage(
        'login-message',
        'E-mail ou senha incorretos.'
      );

    } else {
      setFormMessage(
        'login-message',
        'Não foi possível entrar agora. Tente novamente em alguns instantes.'
      );
    }

    resetCaptcha('login');

  } finally {
    submit.disabled = false;
  }
});

signupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormMessage('signup-message');
  const password = signupForm.elements.password.value;
  const confirmation = signupForm.elements.confirmPassword.value;
  if (password !== confirmation) {
    setFormMessage('signup-message', 'As duas senhas precisam ser iguais.');
    return;
  }

  const submit = signupForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const captchaToken = requireCaptchaToken('signup');
    const data = await signUp(
      signupForm.elements.displayName.value,
      signupForm.elements.email.value,
      password,
      captchaToken
    );
    signupForm.elements.password.value = '';
    signupForm.elements.confirmPassword.value = '';
    if (!data.session) {
      setFormMessage('signup-message', 'Cadastro recebido. Confira seu e-mail para confirmar a conta antes de entrar.', true);
    }
  } catch (error) {
  console.warn('Falha de autenticação:', error);

  const isOffline = !navigator.onLine;

  const isNetworkFailure =
    isOffline ||
    isRetryableNetworkError(error) ||
    error instanceof TypeError ||
    error?.status === 0;

  const isInvalidCredentials =
    error?.code === 'invalid_credentials' ||
    /invalid login credentials/i.test(String(error?.message || ''));

  if (isNetworkFailure) {
    setFormMessage(
      'login-message',
      'Sem conexão com a internet. Verifique sua rede e tente novamente.'
    );
  } else if (isInvalidCredentials) {
    setFormMessage(
      'login-message',
      'E-mail ou senha incorretos.'
    );
  } else {
    setFormMessage(
      'login-message',
      'Não foi possível entrar agora. Tente novamente em alguns instantes.'
    );
  }

  resetCaptcha('login');
}
});

forgotForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormMessage('forgot-message');
  const submit = forgotForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await requestPasswordReset(forgotForm.elements.email.value, requireCaptchaToken('forgot'));
    setFormMessage('forgot-message', 'Se houver uma conta vinculada a esse e-mail, você receberá as instruções de recuperação.', true);
  } catch (error) {
    setFormMessage('forgot-message', 'Se houver uma conta vinculada a esse e-mail, você receberá as instruções de recuperação.', true);
    resetCaptcha('forgot');
  } finally {
    submit.disabled = false;
  }
});

profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentUser) return;
  try {
    currentProfile = await updateProfile(currentUser.id, profileForm.elements.displayName.value);
    updateAccountUI();
    setFormMessage('account-message', 'Nome atualizado.', true);
  } catch (error) {
    setFormMessage('account-message', 'Não foi possível atualizar o perfil.');
  }
});

changePasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormMessage('account-message');
  const currentPassword = changePasswordForm.elements.currentPassword.value;
  const newPassword = changePasswordForm.elements.newPassword.value;
  const confirmation = changePasswordForm.elements.confirmPassword.value;
  if (newPassword !== confirmation) {
    setFormMessage('account-message', 'A confirmação da nova senha não corresponde.');
    return;
  }
  try {
    await changePassword(currentPassword, newPassword);
    changePasswordForm.reset();
    setFormMessage('account-message', 'Senha alterada com sucesso.', true);
  } catch (error) {
    console.warn('Falha ao alterar senha:', error?.code || error?.name || 'password_error');
    setFormMessage('account-message', 'Não foi possível alterar a senha. Confira a senha atual e os requisitos da nova senha.');
  }
});

recoveryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormMessage('recovery-message');
  const password = recoveryForm.elements.password.value;
  const confirmation = recoveryForm.elements.confirmPassword.value;
  if (password !== confirmation) {
    setFormMessage('recovery-message', 'As duas senhas precisam ser iguais.');
    return;
  }
  try {
    await updateRecoveredPassword(password);
    recoveryForm.reset();
    recoveryDialog.close();
    window.history.replaceState(null, '', window.location.pathname);
    showToast('Senha recuperada com sucesso.', 'success');
  } catch (error) {
    console.warn('Falha na recuperação:', error?.code || error?.name || 'recovery_error');
    setFormMessage('recovery-message', 'Não foi possível atualizar a senha. Solicite um novo link se necessário.');
  }
});


mfaLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormMessage('mfa-login-message');
  const submit = mfaLoginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    if (!mfaLoginFactorId) throw new Error('Segundo fator não encontrado.');
    await verifyMfaCode(mfaLoginFactorId, mfaLoginForm.elements.code.value);
    mfaLoginForm.reset();
    const session = await getSession();
    if (!session?.user) throw new Error('Sessão não encontrada após MFA.');
    activeUserLoad = null;
    await enterAuthenticatedApp(session.user);
  } catch (error) {
    console.warn('Falha MFA:', error?.code || error?.name || 'mfa_error');
    setFormMessage('mfa-login-message', 'Código inválido ou expirado. Tente novamente.');
  } finally {
    submit.disabled = false;
  }
});

mfaEnrollForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pendingMfaEnrollment?.id) return;
  const submit = mfaEnrollForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await verifyMfaCode(pendingMfaEnrollment.id, mfaEnrollForm.elements.code.value);
    pendingMfaEnrollment = null;
    mfaEnrollForm.reset();
    document.querySelector('#mfa-setup-panel').hidden = true;
    setFormMessage('account-message', 'Autenticação em duas etapas ativada.', true);
    await refreshMfaPanel();
  } catch (error) {
    setFormMessage('account-message', 'O código do autenticador não pôde ser verificado.');
  } finally {
    submit.disabled = false;
  }
});

async function refreshMfaPanel() {
  const status = document.querySelector('#mfa-status');
  const list = document.querySelector('#mfa-factors-list');
  const enableButton = document.querySelector('#enable-mfa-button');
  status.textContent = 'Verificando...';
  list.replaceChildren();
  try {
    const gate = await getMfaGate();
    const factors = await listMfaFactors();
    const verified = factors.filter((factor) => factor.status === 'verified');
    status.textContent = verified.length
      ? `Proteção ativa. Sessão atual: ${gate.currentLevel === 'aal2' ? 'AAL2' : 'AAL1 — nova confirmação necessária'}.`
      : 'Ainda não há um segundo fator cadastrado.';
    enableButton.hidden = verified.length > 0;

    for (const factor of verified) {
      const row = document.createElement('div');
      row.className = 'dependency-item';
      const label = document.createElement('span');
      label.textContent = factor.friendly_name || 'Aplicativo autenticador';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'small-button';
      remove.dataset.action = 'unenroll-mfa';
      remove.dataset.factorId = factor.id;
      remove.textContent = 'Remover 2FA';
      row.append(label, remove);
      list.appendChild(row);
    }
  } catch (error) {
    status.textContent = 'Não foi possível consultar a configuração de 2FA.';
    enableButton.hidden = true;
  }
}

async function startMfaEnrollment() {
  setFormMessage('account-message');
  try {
    pendingMfaEnrollment = await beginTotpEnrollment('Viora');
    const setup = document.querySelector('#mfa-setup-panel');
    const qr = document.querySelector('#mfa-qr');
    const secret = document.querySelector('#mfa-secret');
    const qrCode = pendingMfaEnrollment?.totp?.qr_code || '';
    qr.src = qrCode.startsWith('data:image/')
      ? qrCode
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrCode)}`;
    secret.value = pendingMfaEnrollment?.totp?.secret || '';
    setup.hidden = false;
    mfaEnrollForm.elements.code.focus();
  } catch (error) {
    console.warn('Falha ao iniciar MFA:', error?.code || error?.name || 'mfa_enroll_error');
    setFormMessage('account-message', 'Não foi possível iniciar a configuração do segundo fator.');
  }
}

projectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(projectForm);
  try {
    const project = createProject(db, {
      name: data.get('name'),
      description: data.get('description'),
      dueDate: data.get('dueDate'),
      color: data.get('color')
    });
    state.selectedProjectId = project.id;
    persist();
    projectDialog.close();
    showToast('Projeto criado.', 'success');
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

taskForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(taskForm);
  const projectId = String(data.get('projectId') || '') || null;
  const hasSteps = data.get('hasSteps') === 'yes';

  try {
    if (hasSteps) {
      const rows = [...document.querySelectorAll('.step-row')];
      const steps = rows.map((row) => ({
        name: row.querySelector('.step-name').value.trim(),
        estimatedMinutes: getMinutes(row.querySelector('.step-hours').value, row.querySelector('.step-minutes').value),
        completionCriteria: row.querySelector('.step-criteria').value.trim()
      })).filter((step) => step.name);
      if (!steps.length) throw new Error('Adicione pelo menos uma etapa com nome.');
      if (steps.some((step) => step.estimatedMinutes <= 0)) throw new Error('Cada etapa precisa de um tempo estimado maior que zero.');

      createTaskWithSteps(db, {
        projectId,
        name: data.get('name'),
        description: data.get('description'),
        dueDate: data.get('dueDate') || null,
        initialEstimateMinutes: steps.reduce((sum, step) => sum + step.estimatedMinutes, 0)
      }, steps);
    } else {
      const estimatedMinutes = getMinutes(data.get('hours'), data.get('minutes'));
      if (estimatedMinutes <= 0) throw new Error('Informe um tempo estimado maior que zero.');
      const dependencyIds = data.getAll('dependencyIds').map(String);

      const prerequisiteName = String(data.get('prerequisiteName') || '').trim();
      if (prerequisiteName) {
        const prerequisiteMinutes = getMinutes(data.get('prerequisiteHours'), data.get('prerequisiteMinutes'));
        if (prerequisiteMinutes <= 0) throw new Error('O novo pré-requisito precisa de uma duração maior que zero.');
        const prerequisite = createTask(db, {
          projectId,
          name: prerequisiteName,
          completionCriteria: data.get('prerequisiteCriteria'),
          estimatedMinutes: prerequisiteMinutes
        });
        dependencyIds.push(prerequisite.id);
      }

      createTask(db, {
        projectId,
        name: data.get('name'),
        description: data.get('description'),
        completionCriteria: data.get('completionCriteria'),
        dueDate: data.get('dueDate') || null,
        estimatedMinutes,
        dependencyIds,
        userDoesNotKnowHowToStart: data.get('doesNotKnowHowToStart') === 'on'
      });
    }

    state.selectedProjectId = projectId;
    persist();
    taskDialog.close();
    showToast('Tarefa salva e planejamento recalculado.', 'success');
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.addEventListener('change', (event) => {
  if (event.target.matches('input[name="hasSteps"]')) {
    const yes = taskForm.elements.hasSteps.value === 'yes';
    document.querySelector('#unit-task-fields').hidden = yes;
    document.querySelector('#steps-fields').hidden = !yes;
    document.querySelector('#decomposition-hint').hidden = true;
  }
  if (event.target.id === 'task-project') renderDependencyOptions(event.target.value);
  if (event.target.id === 'planning-project') {
    state.selectedProjectId = event.target.value === '__standalone__' ? null : event.target.value;
    persist();
    renderPlanning();
  }
  if (event.target.matches('.task-check')) {
    handleTaskToggle(event.target.dataset.taskId, event.target.checked);
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'logical-filter') {
    state.filterQuery = event.target.value;
    updateTaskFilterResults();
  }
  if (taskDialog.open && ['name', 'hours', 'minutes', 'completionCriteria', 'doesNotKnowHowToStart'].includes(event.target.name)) {
    updateDecompositionHint();
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button, .file-button');
  if (!button) return;

  if (button.dataset.authView) {
    setAuthView(button.dataset.authView);
    return;
  }

  if (button.id === 'account-button') {
    updateAccountUI();
    setFormMessage('account-message');
    accountDialog.showModal();
    refreshMfaPanel();
    return;
  }

  if (button.id === 'sign-out-button') {
    accountDialog.close();
    signOut().catch(() => showToast('Não foi possível encerrar a sessão.', 'error'));
    return;
  }

  if (button.id === 'mfa-cancel-login') {
    signOut().catch(() => leaveAuthenticatedApp());
    return;
  }

  if (button.id === 'enable-mfa-button') {
    startMfaEnrollment();
    return;
  }

  if (button.dataset.action === 'unenroll-mfa') {
    try {
      await unenrollMfaFactor(button.dataset.factorId);
      await refreshMfaPanel();
      setFormMessage('account-message', 'Segundo fator removido.', true);
    } catch (error) {
      setFormMessage('account-message', 'Não foi possível remover o segundo fator. Confirme a sessão com 2FA antes de tentar.');
    }
    return;
  }

  if (button.id === 'delete-account-button') {
    const confirmation = document.querySelector('#delete-account-confirmation').value.trim();
    if (confirmation !== 'EXCLUIR MINHA CONTA') {
      setFormMessage('account-message', 'Digite exatamente EXCLUIR MINHA CONTA para confirmar.');
      return;
    }
    askConfirm('Excluir conta definitivamente?', 'Projetos, tarefas, cronômetros e perfil serão apagados. Esta ação não poderá ser desfeita.', async () => {
      try {
        setFormMessage('account-message', 'Excluindo conta...');
        await requestAccountDeletion();
        await signOut('local').catch(() => undefined);
        accountDialog.close();
        leaveAuthenticatedApp();
        setFormMessage('login-message', 'Conta e dados excluídos.', true);
      } catch (error) {
        console.warn('Falha ao excluir conta:', error);
        setFormMessage('account-message', 'Não foi possível excluir a conta. Verifique se a Edge Function delete-account foi implantada e, se usa 2FA, confirme o segundo fator.');
      }
    });
    return;
  }

  if (button.dataset.action === 'close-account-dialog') {
    accountDialog.close();
    return;
  }

  if (button.matches('.nav-item')) {
    state.view = button.dataset.view;
    render();
    return;
  }

  const action = button.dataset.action;
  if (button.id === 'new-project' || action === 'open-project-dialog') return openProjectDialog();
  if (button.id === 'new-task' || action === 'open-task-dialog') return openTaskDialog();
  if (action === 'close-project-dialog') { projectDialog.close(); return; }
  if (action === 'close-task-dialog') { taskDialog.close(); return; }
  if (action === 'load-demo') return loadDemo();

  if (action === 'select-project') {
    state.selectedProjectId = button.dataset.projectId;
    persist();
    renderProjects();
  }
  if (action === 'toggle-new-prerequisite') {
    const panel = document.querySelector('#new-prerequisite-fields');
    panel.hidden = !panel.hidden;
  }
  if (action === 'remove-step') {
    const row = button.closest('.step-row');
    if (document.querySelectorAll('.step-row').length > 1) row.remove();
  }
  if (button.id === 'add-step') addStepRow();

  if (action === 'manage-dependencies') openDependencyManager(button.dataset.taskId);
  if (button.id === 'close-dependency-dialog') dependencyDialog.close();

  if (action === 'add-dependency') {
    const dependencyId = document.querySelector('#dependency-candidate').value;
    if (!dependencyId) return;
    const result = addDependency(db, state.dependencyTaskId, dependencyId);
    if (!result.ok) renderDependencyManager(`Erro: ${result.message}`);
    else {
      persist();
      renderDependencyManager('Dependência adicionada. O grafo foi recalculado sem ciclos.');
      render();
    }
  }

  if (action === 'remove-dependency') {
    removeDependency(db, state.dependencyTaskId, button.dataset.dependencyId);
    persist();
    renderDependencyManager('Dependência removida.');
    render();
  }

  if (action === 'create-quick-prerequisite') {
    const task = getTask(db, state.dependencyTaskId);
    const name = document.querySelector('#quick-prereq-name').value.trim();
    const minutes = getMinutes(document.querySelector('#quick-prereq-hours').value, document.querySelector('#quick-prereq-minutes').value);
    const criteria = document.querySelector('#quick-prereq-criteria').value.trim();
    if (!name || minutes <= 0) return renderDependencyManager('Erro: informe nome e duração válidos para o pré-requisito.');
    try {
      const prereq = createTask(db, { projectId: task.projectId, name, estimatedMinutes: minutes, completionCriteria: criteria });
      const result = addDependency(db, task.id, prereq.id);
      if (!result.ok) throw new Error(result.message);
      persist();
      renderDependencyManager('Pré-requisito criado e vinculado.');
      render();
    } catch (err) {
      renderDependencyManager(`Erro: ${err.message}`);
    }
  }

  if (action === 'start-task') startTask(button.dataset.taskId);
  if (action === 'pause-timer') { pauseTimer(db); persist(); render(); }
  if (action === 'resume-timer') { resumeTimer(db); persist(); render(); }
  if (action === 'stop-timer') {
    const taskId = db.preferences.activeTimer?.taskId;
    const session = stopTimer(db);
    if (session && taskId) {
      persist();
      render();
      openSessionEndDialog(taskId, session.durationSeconds);
    }
  }

  if (action === 'delete-task') {
    const task = getTask(db, button.dataset.taskId);
    askConfirm('Excluir tarefa?', `“${task?.name}” e todas as subtarefas serão removidas. Dependências para elas também serão limpas.`, () => {
      deleteTask(db, button.dataset.taskId);
      persist(); render(); showToast('Tarefa excluída.');
    });
  }
  if (action === 'delete-project') {
    const project = getProject(db, button.dataset.projectId);
    askConfirm('Excluir projeto?', `“${project?.name}” e todas as tarefas serão removidos.`, () => {
      deleteProject(db, button.dataset.projectId);
      state.selectedProjectId = db.projects[0]?.id || null;
      persist(); render(); showToast('Projeto excluído.');
    });
  }

  if (action === 'clear-filter') {
    state.filterQuery = '';
    const input = document.querySelector('#logical-filter');
    if (input) input.value = '';
    updateTaskFilterResults();
  }

  if (button.dataset.time) {
    db.preferences.lastAvailableMinutes = button.dataset.time === 'none' ? null : Number(button.dataset.time);
    persist(); renderNow();
  }
  if (action === 'custom-time') {
    const value = window.prompt('Quantos minutos você tem disponível agora?');
    if (value != null && Number(value) > 0) {
      db.preferences.lastAvailableMinutes = Math.round(Number(value));
      persist(); renderNow();
    }
  }
});

document.querySelector('#confirm-cancel').addEventListener('click', () => {
  state.confirmAction = null;
  confirmDialog.close();
});
document.querySelector('#confirm-ok').addEventListener('click', () => {
  const action = state.confirmAction;
  state.confirmAction = null;
  confirmDialog.close();
  if (action) action();
});


document.querySelector('#session-continue-later').addEventListener('click', keepTaskInProgressAfterSession);
document.querySelector('#session-close').addEventListener('click', keepTaskInProgressAfterSession);
document.querySelector('#session-complete-task').addEventListener('click', completeTaskAfterSession);
sessionEndDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  keepTaskInProgressAfterSession();
});


document.querySelector('#export-db').addEventListener('click', () => {
  const blob = new Blob([exportDatabase(db)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `viora-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

document.querySelector('#import-db').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    db = importDatabase(await file.text());
    state.selectedProjectId = db.projects[0]?.id || null;
    persist();
    showToast('Banco importado com sucesso.', 'success');
    render();
  } catch (err) {
    showToast(err.message, 'error');
  }
  event.target.value = '';
});

setInterval(() => {
  if (!db.preferences.activeTimer || db.preferences.activeTimer.isPaused) return;
  const clock = document.querySelector('#active-timer-clock');
  if (clock) clock.textContent = formatSeconds(getActiveElapsedSeconds(db));
}, 1000);

initializeAuthentication();
