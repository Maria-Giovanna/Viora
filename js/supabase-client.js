import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';

const urlConfigured = Boolean(
  SUPABASE_URL &&
  !SUPABASE_URL.startsWith('COLE_AQUI') &&
  /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL)
);

const keyConfigured = Boolean(
  SUPABASE_PUBLISHABLE_KEY &&
  !SUPABASE_PUBLISHABLE_KEY.startsWith('COLE_AQUI')
);

if (keyConfigured && SUPABASE_PUBLISHABLE_KEY.startsWith('sb_secret_')) {
  throw new Error('SEGURANÇA: uma chave secreta foi colocada no frontend. Remova-a imediatamente.');
}

// Este projeto deliberadamente exige a chave publishable moderna.
if (keyConfigured && !SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_')) {
  throw new Error('Use somente a chave pública moderna sb_publishable_... no frontend.');
}

export const isSupabaseConfigured = urlConfigured && keyConfigured;

if (isSupabaseConfigured && !globalThis.supabase?.createClient) {
  throw new Error('A biblioteca do Supabase não foi carregada. Verifique o script fixado no index.html.');
}

export const supabaseClient = isSupabaseConfigured
  ? globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage
      }
    })
  : null;
