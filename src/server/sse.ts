interface Sink { write(s: string): unknown; }

export class SseHub {
  private clients = new Set<Sink>();
  add(res: Sink) { this.clients.add(res); }
  remove(res: Sink) { this.clients.delete(res); }
  send(res: Sink, event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  broadcast(event: string, data: unknown) {
    for (const c of this.clients) this.send(c, event, data);
  }
  count() { return this.clients.size; }
}
