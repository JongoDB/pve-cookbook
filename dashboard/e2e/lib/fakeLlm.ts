import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted OpenAI-compatible model (POST /v1/chat/completions, streamed).
 * galley talks to it like to any OpenAI-compatible provider, so the in-app
 * assistant runs end to end without a real model. Each turn answers from
 * `script` by the number of model calls in the conversation so far.
 */
export type Step =
  | { text: string }
  | { tool: string; args: Record<string, unknown>; text?: string };

export class FakeLlm {
  server: Server;
  requests: { messages: { role: string; content?: unknown }[]; tools: unknown[] }[] = [];
  /** answers for each model call, in order; the last one repeats */
  script: Step[] = [{ text: 'Hello.' }];
  private n = 0;

  constructor() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
        const b = JSON.parse(body);
        this.requests.push({ messages: b.messages, tools: b.tools ?? [] });
        const step = this.script[Math.min(this.n++, this.script.length - 1)];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`);
        const delta = (d: unknown, finish?: string) => chunk({ choices: [{ index: 0, delta: d, ...(finish ? { finish_reason: finish } : {}) }] });
        if (step.text) {
          // stream in small pieces, like a model
          for (const piece of step.text.match(/[\s\S]{1,24}/g) ?? []) delta({ content: piece });
        }
        if ('tool' in step) {
          delta({ tool_calls: [{ index: 0, id: `call_${this.n}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] });
          delta({}, 'tool_calls');
        } else {
          delta({}, 'stop');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  reset(script: Step[]) { this.script = script; this.n = 0; this.requests = []; }
  async stop() { await new Promise((r) => this.server.close(r)); }
}
