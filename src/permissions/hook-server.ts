// Loopback-only HTTP listener for the PreToolUse + Stop hook callbacks from `claude`,
// plus the orchestrator's per-session work hooks (plan-ready, replies-ready, edits-done,
// step-resolved, step-failed). Every endpoint requires the per-launch secret in
// `x-daemon-auth`; the PWA-facing surface is in `src/server.ts`.

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface HookServerOpts {
  port: number;
  daemonAuthSecret: string;
  onPreToolHook: (body: string) => Promise<string>;
  onStopHook: (body: string) => Promise<void>;
  onStatusLineHook: (body: string) => Promise<void>;
  onWorkPlanReady: (body: string) => Promise<void>;
  onWorkRepliesReady: (body: string) => Promise<void>;
  onWorkEditDone: (body: string) => Promise<void>;
  onWorkStepResolved: (body: string) => Promise<void>;
  onWorkStepFailed: (body: string) => Promise<void>;
  onActionProposal: (body: string) => Promise<void>;
  onWorkJournal: (body: string) => Promise<void>;
  onMcp: (body: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  onCreateJob?: (payload: {
    source: string;
    title: string;
    body?: string;
    dedupeKey?: string;
    externalRef?: { url: string; issueIdentifier?: string; linearUuid?: string };
  }) => Promise<{ jobId: string; created: boolean }>;
}

export class HookServer {
  private readonly http: HttpServer;

  constructor(private opts: HookServerOpts) {
    this.http = createServer((req, res) => this.handle(req, res));
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.http.listen(this.opts.port, '127.0.0.1', () => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const KNOWN_ROUTES = new Set([
      '/hook/pretool',
      '/hook/stop',
      '/hook/statusline',
      '/work/plan-ready',
      '/work/replies-ready',
      '/work/edits/done',
      '/work/step-resolved',
      '/work/step-failed',
      '/work/action-proposal',
      '/work/journal',
      '/work/create-job',
      '/mcp',
    ]);
    if (req.method !== 'POST' || !KNOWN_ROUTES.has(req.url ?? '')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (req.headers['x-daemon-auth'] !== this.opts.daemonAuthSecret) {
      console.log(`[hook-server] 401 from ${req.socket.remoteAddress}`);
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    const url = req.url;
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', async () => {
      try {
        if (url === '/hook/pretool') {
          const result = await this.opts.onPreToolHook(body);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(result);
        } else if (url === '/hook/statusline') {
          await this.opts.onStatusLineHook(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/hook/stop') {
          await this.opts.onStopHook(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/plan-ready') {
          await this.opts.onWorkPlanReady(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/replies-ready') {
          await this.opts.onWorkRepliesReady(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/edits/done') {
          await this.opts.onWorkEditDone(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/step-resolved') {
          await this.opts.onWorkStepResolved(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/step-failed') {
          await this.opts.onWorkStepFailed(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/action-proposal') {
          await this.opts.onActionProposal(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/journal') {
          await this.opts.onWorkJournal(body);
          res.statusCode = 204;
          res.end();
        } else if (url === '/work/create-job') {
          if (!this.opts.onCreateJob) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          const raw = JSON.parse(body) as Record<string, unknown>;
          if (
            typeof raw.source !== 'string' || !raw.source.trim() ||
            typeof raw.title !== 'string' || !raw.title.trim()
          ) {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'source and title are required strings' }));
            return;
          }
          const result = await this.opts.onCreateJob({
            source: raw.source,
            title: raw.title,
            body: raw.body != null ? String(raw.body) : undefined,
            dedupeKey: raw.dedupeKey != null ? String(raw.dedupeKey) : undefined,
            externalRef: raw.externalRef as { url: string; issueIdentifier?: string; linearUuid?: string } | undefined,
          });
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result));
        } else if (url === '/mcp') {
          const reply = await this.opts.onMcp(body);
          res.statusCode = reply.status;
          for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
          res.end(reply.body);
        } else {
          res.statusCode = 404;
          res.end('not found');
        }
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[hook-server] handler error (${url}):`, (e as Error).stack);
        if (url === '/hook/pretool') {
          res.statusCode = 500;
          res.end('error');
        } else if (url === '/work/plan-ready' || url === '/work/create-job') {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: msg }));
        } else {
          res.statusCode = 204;
          res.end();
        }
      }
    });
    req.on('error', () => {
      res.statusCode = 400;
      res.end('bad request');
    });
  }
}
