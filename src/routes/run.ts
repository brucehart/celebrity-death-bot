import type { Env } from '../types';
import { runJob } from '../services/job';

export async function manualRun(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('authorization') || request.headers.get('Authorization');
  const token = (() => {
    if (!auth) return '';
    const maybeBearer = auth.trim();
    const m = /^Bearer\s+(.+)$/i.exec(maybeBearer);
    return m ? m[1].trim() : maybeBearer;
  })();
  if (!token || token !== env.MANUAL_RUN_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const res = await runJob(env);
    return Response.json({ ok: true, ...res });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}

