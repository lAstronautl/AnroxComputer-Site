/**
 * A live connection to a battle: the Worker's Durable Object pushes the state over a WebSocket and takes the keys back.
 * If the Worker has no live rooms (or the socket breaks), `open` stays false and the scene keeps polling over HTTP.
 */

const STALE_MS = 2000; // no push for this long — the socket is treated as dead and polling takes over

export function createLive(socket, game, onState) {
  let ws = null;
  let open = false;
  let failures = 0;
  let last = 0;

  return {
    /** True while the server is pushing fresh states. */
    get fresh() {
      return open && Date.now() - last < STALE_MS;
    },
    connect() {
      if (ws || failures >= 3) return;
      ws = socket(game);
      if (!ws) {
        failures = 3;
        return;
      }
      const mine = ws;
      mine.onopen = () => {
        open = true;
        last = Date.now();
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
        if (!open) failures += 1;
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
