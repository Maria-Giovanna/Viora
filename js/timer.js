import { makeId } from './engine.js';

export function startTimer(db, taskId) {
  if (db.preferences.activeTimer?.taskId === taskId && !db.preferences.activeTimer.isPaused) {
    return db.preferences.activeTimer;
  }

  if (db.preferences.activeTimer && db.preferences.activeTimer.taskId !== taskId) {
    throw new Error('Já existe outra tarefa com cronômetro ativo. Pause ou encerre a sessão primeiro.');
  }

  const active = db.preferences.activeTimer;
  db.preferences.activeTimer = {
    taskId,
    startedAt: new Date().toISOString(),
    accumulatedSeconds: active?.taskId === taskId ? active.accumulatedSeconds : 0,
    isPaused: false
  };
  return db.preferences.activeTimer;
}

export function pauseTimer(db) {
  const active = db.preferences.activeTimer;
  if (!active || active.isPaused) return active;
  active.accumulatedSeconds = getActiveElapsedSeconds(db);
  active.startedAt = null;
  active.isPaused = true;
  return active;
}

export function resumeTimer(db) {
  const active = db.preferences.activeTimer;
  if (!active || !active.isPaused) return active;
  active.startedAt = new Date().toISOString();
  active.isPaused = false;
  return active;
}

export function stopTimer(db) {
  const active = db.preferences.activeTimer;
  if (!active) return null;

  const durationSeconds = getActiveElapsedSeconds(db);
  const session = {
    id: makeId('timer'),
    taskId: active.taskId,
    startedAt: active.startedAt,
    endedAt: new Date().toISOString(),
    durationSeconds
  };
  db.timerSessions.push(session);
  db.preferences.activeTimer = null;
  return session;
}

export function cancelTimer(db) {
  db.preferences.activeTimer = null;
}

export function getActiveElapsedSeconds(db) {
  const active = db.preferences.activeTimer;
  if (!active) return 0;
  if (active.isPaused || !active.startedAt) return active.accumulatedSeconds || 0;
  const currentChunk = Math.max(0, Math.floor((Date.now() - new Date(active.startedAt).getTime()) / 1000));
  return (active.accumulatedSeconds || 0) + currentChunk;
}

export function getTaskActualSeconds(db, taskId) {
  const sessions = db.timerSessions.filter((session) => session.taskId === taskId);
  let total = sessions.reduce((sum, session) => sum + (Number(session.durationSeconds) || 0), 0);
  if (db.preferences.activeTimer?.taskId === taskId) total += getActiveElapsedSeconds(db);
  return total;
}

export function formatSeconds(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}
