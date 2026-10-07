// Single shared WebSocket manager: heartbeat, reconnect, typed fan-out.
// Matches the API realtime contract (plan.md section 7).

export interface SocketEvent {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
}

type Handler = (ev: SocketEvent) => void;

const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 15_000;

export class Talk2Socket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private intentionalClose = false;

  constructor(private getToken: () => string | null) {}

  connect() {
    this.intentionalClose = false;
    this.open();
  }

  private open() {
    const token = this.getToken();
    if (!token) return;
    const wsUrl = `${(
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8081"
    ).replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      this.send({ type: "heartbeat" });
      this.startHeartbeat();
    };
    ws.onmessage = (msg) => {
      let ev: SocketEvent;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        return;
      }
      this.handlers.forEach((h) => h(ev));
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      // Logged-out tokens are dead: getToken() goes null on logout,
      // so reconnect attempts stop by themselves.
      if (!this.intentionalClose && this.getToken()) {
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        this.reconnectTimer = setTimeout(() => this.open(), delay);
      }
    };
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  send(ev: SocketEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(ev));
    }
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close() {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }
}
