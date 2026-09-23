import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Server } from 'node:http';
import type {
  ClientMsg, DisplaySettings, LyricDoc, NowPlaying, Palette, PlaybackAnchor, ServerMsg, SceneMode,
} from '@lyricroom/shared';
import { WS_PATH } from '@lyricroom/shared';
import { monoNow } from './clock.js';

export interface HubHandlers {
  onNudge(trackKey: string, deltaMs: number): void;
  onControl(action: 'playpause' | 'next' | 'previous' | 'reloadLyrics' | 'nextProvider'): void;
  onSetMode(mode: SceneMode | 'auto'): void;
  onSetSettings(settings: Partial<DisplaySettings>): void;
  snapshot(): ServerMsg[];
}

/**
 * Fan-out of daemon state to every connected surface (the room display, the
 * phone remote, a dev tab). Late joiners get a full snapshot on connect so a
 * browser refresh never shows an empty screen.
 */
export class Hub {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(server: Server, private handlers: HubHandlers) {
    this.wss = new WebSocketServer({ server, path: WS_PATH });
    this.wss.on('connection', (socket) => this.onConnection(socket));
  }

  private onConnection(socket: WebSocket): void {
    this.clients.add(socket);
    this.sendTo(socket, { type: 'hello', serverMs: monoNow(), version: '0.1.0' });
    for (const msg of this.handlers.snapshot()) this.sendTo(socket, msg);

    socket.on('message', (raw: RawData) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ping':
          // Reply immediately so the client can estimate one-way latency.
          this.sendTo(socket, { type: 'pong', clientSent: msg.clientSent, serverMs: monoNow() });
          break;
        case 'nudge':
          this.handlers.onNudge(msg.trackKey, msg.deltaMs);
          break;
        case 'control':
          this.handlers.onControl(msg.action);
          break;
        case 'setmode':
          this.handlers.onSetMode(msg.mode);
          break;
        case 'setsettings':
          if (msg.settings && typeof msg.settings === 'object') this.handlers.onSetSettings(msg.settings);
          break;
      }
    });

    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => {
      this.clients.delete(socket);
      try { socket.terminate(); } catch { /* already gone */ }
    });
  }

  private sendTo(socket: WebSocket, msg: ServerMsg): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(msg)); } catch { /* dropped */ }
  }

  broadcast(msg: ServerMsg): void {
    const payload = JSON.stringify(msg);
    for (const socket of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try { socket.send(payload); } catch { /* dropped */ }
    }
  }

  get size(): number {
    return this.clients.size;
  }

  close(): void {
    for (const c of this.clients) { try { c.close(); } catch { /* ignore */ } }
    this.wss.close();
  }
}

export function nowPlayingMsg(track: NowPlaying | null, anchor: PlaybackAnchor): ServerMsg {
  return { type: 'nowplaying', track, anchor };
}
export function lyricsMsg(trackKey: string, doc: LyricDoc | null, offsetMs: number): ServerMsg {
  return { type: 'lyrics', trackKey, doc, offsetMs };
}
export function paletteMsg(trackKey: string, palette: Palette | null): ServerMsg {
  return { type: 'palette', trackKey, palette };
}
