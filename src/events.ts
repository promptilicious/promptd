import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { BusEvent } from './types.js';

export const bus = new EventEmitter<{ event: [BusEvent] }>();
bus.setMaxListeners(0);

export function emit(type: string, payload: object = {}): void {
  bus.emit('event', { type, ...payload, at: new Date().toISOString() });
}

export function sseInit(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
}

export function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
