import type { ClientMsg, ServerMsg } from '@lyricroom/shared';
import { ServerClock } from './clock.js';

export type MsgHandler = (msg: ServerMsg) => void;

/**
 * Resilient socket to the daemon. A room display must survive the daemon
 * restarting, the network blinking, and the machine sleeping, without anyone
 * touching a keyboard -- so every failure path ends in "try again shortly".
 */
export class Connection {
  readonly clock = new ServerClock();
  private ws: WebSocket | null = null;
  private handlers: MsgHandler[] = [];
  private pingTimer: number | null = null;
  private retry = 0;
  private closed = false;

  constructor(private url: string) {}

  on(handler: MsgHandler): void {
    this.handlers.push(handler);
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.ping();
      // Dense at first to lock the clock quickly, then a slow keep-alive.
      let sent = 0;
      this.pingTimer = window.setInterval(() => {
        this.ping();
        sent += 1;
        if (sent === 6 && this.pingTimer !== null) {
          clearInterval(this.pingTimer);
          this.pingTimer = window.setInterval(() => this.ping(), 15_000);
        }
      }, 400);
    });

    ws.addEventListener('message', (ev: MessageEvent<string>) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        this.clock.accept(msg.clientSent, msg.serverMs);
        return;
      }
      if (msg.type === 'hello') {
        this.ping();
      }
      for (const h of this.handlers) h(msg);
    });

    const reconnect = (): void => {
      if (this.pingTimer !== null) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.closed || this.ws !== ws) return;
      this.ws = null;
      this.retry += 1;
      const delay = Math.min(8000, 400 * 2 ** Math.min(this.retry, 5));
      window.setTimeout(() => this.connect(), delay);
    };
    ws.addEventListener('close', reconnect);
    ws.addEventListener('error', reconnect);
  }

  private ping(): void {
    this.send({ type: 'ping', clientSent: performance.now() });
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
