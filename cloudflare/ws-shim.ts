import { EventEmitter } from 'node:events';
export class WebSocket extends EventEmitter {
  static OPEN = 1;
  constructor(public raw: globalThis.WebSocket) { super(); }
  get readyState() { return this.raw.readyState; }
  send(data: string) { this.raw.send(data); }
  close(code?: number, reason?: string) { this.raw.close(code ?? 1000,reason); }
}
export class WebSocketServer extends EventEmitter {
  constructor(_opts: any) { super(); }
  handleUpgrade(request: any, _socket: any, _head: any, cb: any) { cb(request.__socket); }
  close() {}
}
