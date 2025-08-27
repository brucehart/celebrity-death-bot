import type { Env } from './types.ts';

// Tiny exact-match router for Worker routes.
// - Matches method + pathname exactly (no params, no patterns). Keep minimal to avoid overhead.
type Handler = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;

export class Router {
	private routes = new Map<string, Handler>();

	on(method: string, path: string, handler: Handler) {
		this.routes.set(`${method.toUpperCase()} ${path}`, handler);
		return this;
	}

	match(method: string, path: string): Handler | undefined {
		return this.routes.get(`${method.toUpperCase()} ${path}`);
	}

	async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const handler = this.match(request.method, url.pathname);
		if (handler) return handler(request, env, ctx);
		return new Response('Not found', { status: 404 });
	}
}
