import { isSupabaseConfigured, supabaseClient } from './supabase-client.js';

function requireClient() {
  if (!isSupabaseConfigured || !supabaseClient) {
    throw new Error('Supabase ainda não foi configurado neste projeto.');
  }
  return supabaseClient;
}

function cleanEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) {
    throw new Error('Informe um e-mail válido.');
  }
  return value;
}

export function passwordProblems(password) {
  const value = String(password ?? '');
  const problems = [];
  if (value.length < 12) problems.push('pelo menos 12 caracteres');
  if (value.length > 128) problems.push('no máximo 128 caracteres');
  if (!/[a-z]/.test(value)) problems.push('uma letra minúscula');
  if (!/[A-Z]/.test(value)) problems.push('uma letra maiúscula');
  if (!/\d/.test(value)) problems.push('um número');
  if (!/[^A-Za-z0-9]/.test(value)) problems.push('um símbolo');
  return problems;
}

export function validateStrongPassword(password) {
  const problems = passwordProblems(password);
  if (problems.length) throw new Error(`A senha precisa ter ${problems.join(', ')}.`);
}

export async function getSession() {
  const client = requireClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthStateChange(callback) {
  const client = requireClient();
  return client.auth.onAuthStateChange((event, session) => {
    setTimeout(() => callback(event, session), 0);
  });
}

export async function signIn(email, password, captchaToken = null) {
  const client = requireClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: cleanEmail(email),
    password: String(password ?? ''),
    options: captchaToken ? { captchaToken } : undefined
  });
  if (error) throw error;
  return data;
}

export async function signUp(displayName, email, password, captchaToken = null) {
  validateStrongPassword(password);
  const name = String(displayName ?? '').trim();
  if (!name || name.length > 60) throw new Error('Informe um nome de até 60 caracteres.');
  const client = requireClient();
  const redirectUrl = `${window.location.origin}${window.location.pathname}`;
  const { data, error } = await client.auth.signUp({
    email: cleanEmail(email),
    password,
    options: {
      emailRedirectTo: redirectUrl,
      data: { display_name: name },
      ...(captchaToken ? { captchaToken } : {})
    }
  });
  if (error) throw error;
  return data;
}

export async function requestPasswordReset(email, captchaToken = null) {
  const client = requireClient();
  const redirectUrl = `${window.location.origin}${window.location.pathname}#recovery`;
  const { error } = await client.auth.resetPasswordForEmail(cleanEmail(email), {
    redirectTo: redirectUrl,
    ...(captchaToken ? { captchaToken } : {})
  });
  if (error) throw error;
}

export async function updateRecoveredPassword(password) {
  validateStrongPassword(password);
  const client = requireClient();
  const { data, error } = await client.auth.updateUser({ password });
  if (error) throw error;
  return data;
}

export async function changePassword(currentPassword, newPassword) {
  validateStrongPassword(newPassword);
  const client = requireClient();
  const { data, error } = await client.auth.updateUser({
    password: newPassword,
    current_password: String(currentPassword ?? '')
  });
  if (error) throw error;
  return data;
}

export async function signOut(scope = 'global') {
  const client = requireClient();
  if (!['global', 'local', 'others'].includes(scope)) throw new Error('Escopo de logout inválido.');
  const { error } = await client.auth.signOut({ scope });
  if (error) throw error;
}

export async function getProfile(userId) {
  const client = requireClient();
  const { data, error } = await client
    .from('profiles')
    .select('id, display_name, created_at, updated_at')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateProfile(userId, displayName) {
  const name = String(displayName ?? '').trim();
  if (!name || name.length > 60) throw new Error('Informe um nome de até 60 caracteres.');
  const client = requireClient();
  const { data, error } = await client
    .from('profiles')
    .update({ display_name: name, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select('id, display_name, created_at, updated_at')
    .single();
  if (error) throw error;
  return data;
}

export async function getMfaAssurance() {
  const client = requireClient();
  const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  return data;
}

export async function listMfaFactors() {
  const client = requireClient();
  const { data, error } = await client.auth.mfa.listFactors();
  if (error) throw error;
  return [...(data?.totp ?? []), ...(data?.phone ?? [])];
}

export async function getMfaGate() {
  const [aal, factors] = await Promise.all([getMfaAssurance(), listMfaFactors()]);
  const verified = factors.filter((factor) => factor.status === 'verified');
  return {
    currentLevel: aal?.currentLevel ?? null,
    nextLevel: aal?.nextLevel ?? null,
    verifiedFactors: verified,
    requiresChallenge: verified.length > 0 && aal?.currentLevel !== 'aal2'
  };
}

export async function beginTotpEnrollment(friendlyName = 'Viora') {
  const client = requireClient();
  const { data, error } = await client.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: String(friendlyName || 'Viora').slice(0, 64)
  });
  if (error) throw error;
  return data;
}

export async function verifyMfaCode(factorId, code) {
  const client = requireClient();
  const cleanCode = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleanCode)) throw new Error('Digite o código de 6 dígitos do autenticador.');
  const { data, error } = await client.auth.mfa.challengeAndVerify({
    factorId,
    code: cleanCode
  });
  if (error) throw error;
  return data;
}

export async function unenrollMfaFactor(factorId) {
  const client = requireClient();
  const { data, error } = await client.auth.mfa.unenroll({ factorId });
  if (error) throw error;
  return data;
}

export async function requestAccountDeletion() {
  const client = requireClient();
  const gate = await getMfaGate();
  if (gate.verifiedFactors.length > 0 && gate.currentLevel !== 'aal2') {
    throw new Error('Confirme o segundo fator antes de excluir a conta.');
  }
  const { data, error } = await client.functions.invoke('delete-account', {
    body: { confirmation: 'EXCLUIR MINHA CONTA' }
  });
  if (error) throw error;
  return data;
}
