import { withSupabase } from 'npm:@supabase/server@1.4.1'

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function originAllowed(req: Request) {
  const configuredOrigins = (Deno.env.get('TASKFLOW_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (!configuredOrigins.length) return true
  const origin = req.headers.get('origin')
  return Boolean(origin && configuredOrigins.includes(origin))
}

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (!originAllowed(req)) return json({ error: 'Origem não autorizada.' }, 403)
    if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405)

    let body: { confirmation?: string }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Corpo inválido.' }, 400)
    }

    if (body.confirmation !== 'EXCLUIR MINHA CONTA') {
      return json({ error: 'Confirmação inválida.' }, 400)
    }

    const { data: userData, error: userError } = await ctx.supabase.auth.getUser()
    if (userError || !userData.user) return json({ error: 'Sessão inválida.' }, 401)

    // Se a conta tem MFA cadastrado, a própria RLS da aplicação já exige AAL2.
    // Aqui repetimos a checagem antes da operação destrutiva.
    const { data: aal, error: aalError } = await ctx.supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aalError) return json({ error: 'Não foi possível validar o nível de autenticação.' }, 401)
    if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      return json({ error: 'Confirme o segundo fator antes de excluir a conta.' }, 403)
    }

    const userId = userData.user.id

    // Remove primeiro os dados da aplicação. ctx.supabaseAdmin só existe no
    // ambiente da Edge Function e usa a chave secreta provisionada pelo Supabase.
    for (const table of ['task_dependencies', 'timer_sessions', 'tasks', 'projects', 'user_preferences', 'profiles']) {
      const column = table === 'profiles' ? 'id' : 'user_id'
      const { error } = await ctx.supabaseAdmin.from(table).delete().eq(column, userId)
      if (error) {
        console.error(`Falha ao excluir ${table}:`, error)
        return json({ error: 'Não foi possível concluir a exclusão dos dados.' }, 500)
      }
    }

    // Exclusão permanente: evita reter indefinidamente a identidade após o pedido
    // explícito de apagamento. O método admin só roda no servidor/Edge Function.
    const { error: deleteUserError } = await ctx.supabaseAdmin.auth.admin.deleteUser(userId, false)
    if (deleteUserError) {
      console.error('Falha ao excluir identidade de autenticação:', deleteUserError)
      return json({ error: 'Os dados foram removidos, mas a identidade de autenticação exige revisão administrativa.' }, 500)
    }

    return json({ ok: true }, 200)
  }),
}
