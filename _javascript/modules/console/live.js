/**
 * A live connection to a battle: the Worker's Durable Object pushes the state over a WebSocket and takes the keys back.
 * If the Worker has no live rooms (or the socket breaks), `open` stays false and the scene keeps polling over HTTP.
 */

const STALE_MS = 2000; // no push for this long — the socket is treated as dead and polling takes over

export function createLive(socket, game, onState) {
  let ws = null;
  let open = false;
  let failures = 0;
  let retryAt = 0;
  let last = 0;
  let openedAt = 0;

  return {
    /** True while the server is pushing fresh states. */
    get fresh() {
      return open && Date.now() - last < STALE_MS;
    },
    connect() {
      if (ws || Date.now() < retryAt) return;
      ws = socket(game);
      if (!ws) {
        retryAt = Infinity; // no sockets in this backend: polling for good
        return;
      }
      const mine = ws;
      mine.onopen = () => {
        open = true;
        openedAt = Date.now();
        last = openedAt;
      };
      mine.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.lobby) {
            last = Date.now();
            onState(message.lobby);
          }
        } catch {
          // ignore a broken frame
        }
      };
      mine.onclose = () => {
        // a failed or short-lived connection waits longer each time before the next try (1 s, 2 s, 4 s … 30 s)
        failures = open && Date.now() - openedAt > 2000 ? 0 : failures + 1;
        retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
        if (ws === mine) ws = null;
        open = false;
      };
      mine.onerror = () => {};
    },
    send(body) {
      if (!this.fresh) return false;
      try {
        ws.send(JSON.stringify(body));
        return true;
      } catch {
        return false;
      }
    },
    close() {
      const old = ws;
      ws = null;
      open = false;
      if (old) {
        old.onclose = null;
        old.close();
      }
    }
  };
}
