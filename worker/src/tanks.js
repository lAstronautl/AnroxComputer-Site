/**
 * «Танчики» (по мотивам Battle City): арена на 2–4 игрока, каждый сам за себя.
 * Чистая логика без базы. Игра идёт тактами: ходы приходят как «намерения» (куда ехать, куда стрелять),
 * сервер раз в такт исполняет их для всех сразу — поэтому небольшая задержка сети никому не мешает.
 * Расположение танков в кустах скрыто: `tankView` не показывает чужие танки в кустах издалека.
 */

export const TANK_TICK_MS = 300;
export const TANK_COUNTDOWN = 10; // тактов до начала боя
export const TANK_MAX_TICKS = 600; // бой не длиннее трёх минут
export const TANK_LIVES = 3;
export const TANK_SHIELD = 5; // тактов неуязвимости после возрождения
const BULLET_STEPS = 2; // клеток за такт у снаряда
export const TANK_LOG = 30;

export const TANK_W = 19;
export const TANK_H = 13;

// . пусто · B кирпич (пробивается) · S сталь · W вода (танк не проедет, снаряд пролетит) · G кусты (скрывают танк)
export const TANK_MAPS = {
  yard: {
    name: 'Кирпичный двор',
    rows: [
      '...................',
      '.BB.BB..S.S..BB.BB.',
      '.BB.BB.......BB.BB.',
      '...................',
      '.SS..BBB...BBB..SS.',
      '.....B.......B.....',
      '..B..B.GGGGG.B..B..',
      '.....B.......B.....',
      '.SS..BBB...BBB..SS.',
      '...................',
      '.BB.BB.......BB.BB.',
      '.BB.BB..S.S..BB.BB.',
      '...................'
    ]
  },
  maze: {
    name: 'Стальной лабиринт',
    rows: [
      '...................',
      '.S.BBB.S...S.BBB.S.',
      '.S.....S.B.S.....S.',
      '.S.SSS.......SSS.S.',
      '...S...BB.BB...S...',
      'BB.S.BB.....BB.S.BB',
      '...W...........W...',
      'BB.S.BB.....BB.S.BB',
      '...S...BB.BB...S...',
      '.S.SSS.......SSS.S.',
      '.S.....S.B.S.....S.',
      '.S.BBB.S...S.BBB.S.',
      '...................'
    ]
  },
  river: {
    name: 'Река',
    rows: [
      '...................',
      '.BB..GG.....GG..BB.',
      '.BB..GG.B.B.GG..BB.',
      '...................',
      '.S...............S.',
      'WWW..WWWWWWWWW..WWW',
      'WWW..W.......W..WWW',
      'WWW..WWWWWWWWW..WWW',
      '.S...............S.',
      '...................',
      '.BB..GG.B.B.GG..BB.',
      '.BB..GG.....GG..BB.',
      '...................'
    ]
  }
};

// где появляется каждый танк: по углам арены
const TANK_SPAWNS = [
  [0, 0],
  [TANK_W - 1, TANK_H - 1],
  [TANK_W - 1, 0],
  [0, TANK_H - 1]
];

const TANK_DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
export const isDir = (value) => Object.hasOwn(TANK_DIRS, value);

const tankNote = (state, event) => {
  state.log.push({ tick: state.tick, ...event });
  if (state.log.length > TANK_LOG) state.log.splice(0, state.log.length - TANK_LOG);
};

const tankCell = (state, x, y) => (x < 0 || y < 0 || x >= TANK_W || y >= TANK_H ? '#' : state.grid[y][x]);
const tankAt = (state, x, y) => state.players.findIndex((player) => player.alive && player.x === x && player.y === y);

function tankSetCell(state, x, y, value) {
  const row = state.grid[y];
  state.grid[y] = row.slice(0, x) + value + row.slice(x + 1);
}

/** The nearest free cell to a spawn point (the spawn itself unless a tank sits on it). */
function tankFreeNear(state, [sx, sy]) {
  const seen = new Set([`${sx},${sy}`]);
  const queue = [[sx, sy]];
  while (queue.length) {
    const [x, y] = queue.shift();
    if (['.', 'G'].includes(tankCell(state, x, y)) && tankAt(state, x, y) < 0) return [x, y];
    for (const [dx, dy] of Object.values(TANK_DIRS)) {
      const next = [x + dx, y + dy];
      const mark = `${next[0]},${next[1]}`;
      if (tankCell(state, next[0], next[1]) !== '#' && !seen.has(mark)) {
        seen.add(mark);
        queue.push(next);
      }
    }
  }
  return [sx, sy];
}

export function tankStart(players, mapId, stake, now) {
  const map = TANK_MAPS[mapId] ?? TANK_MAPS.yard;
  const state = {
    map: TANK_MAPS[mapId] ? mapId : 'yard',
    mapName: map.name,
    grid: [...map.rows],
    tick: 0,
    nextTick: now + TANK_TICK_MS,
    stake,
    pot: stake * players.length,
    players: players.map((player, seat) => ({
      key: player.key,
      name: player.name,
      x: TANK_SPAWNS[seat][0],
      y: TANK_SPAWNS[seat][1],
      dir: seat === 1 || seat === 2 ? 'L' : 'R',
      alive: true,
      lives: TANK_LIVES,
      kills: 0,
      shield: 0,
      cool: 0,
      cmd: { move: null, fire: null },
      seen: 0 // the stamp of the last input that was carried out
    })),
    bullets: [],
    log: [],
    over: false,
    winners: []
  };
  tankNote(state, { type: 'start' });
  return state;
}

/** The player's wish for the next tick: where to drive and/or where to shoot. A newer wish replaces the older one. */
export function tankInput(state, seat, move, fire) {
  const player = state.players[seat];
  if (!player || !player.alive || state.over) return;
  if (isDir(move)) player.cmd.move = move;
  if (isDir(fire)) player.cmd.fire = fire;
}

function tankFinish(state, winners) {
  state.over = true;
  state.winners = winners;
  state.bullets = [];
  tankNote(state, { type: 'over', winners });
}

function tankCheckEnd(state) {
  if (state.over) return;
  const alive = state.players.map((player, seat) => (player.alive ? seat : -1)).filter((seat) => seat >= 0);
  if (alive.length <= 1) tankFinish(state, alive);
}

function tankHit(state, victimSeat, ownerSeat) {
  const victim = state.players[victimSeat];
  victim.lives -= 1;
  const owner = state.players[ownerSeat];
  if (owner && ownerSeat !== victimSeat) owner.kills += 1;
  if (victim.lives <= 0) {
    victim.alive = false;
    tankNote(state, { type: 'dead', victim: victimSeat, owner: ownerSeat });
    tankCheckEnd(state);
    return;
  }
  tankNote(state, { type: 'hit', victim: victimSeat, owner: ownerSeat, lives: victim.lives });
  const [x, y] = tankFreeNear(state, TANK_SPAWNS[victimSeat]);
  victim.x = x;
  victim.y = y;
  victim.shield = TANK_SHIELD;
}

function tankMoveBullets(state) {
  for (let step = 0; step < BULLET_STEPS; step += 1) {
    for (const bullet of [...state.bullets]) {
      if (!state.bullets.includes(bullet)) continue; // already removed in this step
      const [dx, dy] = TANK_DIRS[bullet.dir];
      const x = bullet.x + dx;
      const y = bullet.y + dy;
      const remove = () => {
        state.bullets = state.bullets.filter((item) => item !== bullet);
      };
      const cell = tankCell(state, x, y);
      if (cell === '#' || cell === 'S') {
        remove();
        continue;
      }
      if (cell === 'B') {
        tankSetCell(state, x, y, '.');
        remove();
        continue;
      }
      const other = state.bullets.find((item) => item !== bullet && item.x === x && item.y === y);
      if (other) {
        state.bullets = state.bullets.filter((item) => item !== bullet && item !== other);
        continue;
      }
      const victim = tankAt(state, x, y);
      if (victim >= 0) {
        remove();
        if (state.players[victim].shield <= 0) tankHit(state, victim, bullet.owner);
        if (state.over) return;
        continue;
      }
      bullet.x = x;
      bullet.y = y;
    }
  }
}

/** One tick of the battle. */
export function tankStep(state) {
  if (state.over) return;
  state.tick += 1;

  if (state.tick <= TANK_COUNTDOWN) {
    for (const player of state.players) player.cmd = { move: null, fire: null };
    if (state.tick === TANK_COUNTDOWN) tankNote(state, { type: 'go' });
    return;
  }

  const count = state.players.length;
  for (let i = 0; i < count; i += 1) {
    // the order of moves is rotated, so nobody always wins the fight for a cell
    const seat = (i + state.tick) % count;
    const player = state.players[seat];
    if (!player.alive) continue;
    const { move, fire } = player.cmd;
    player.cmd = { move: null, fire: null };
    if (move) {
      player.dir = move;
      const [dx, dy] = TANK_DIRS[move];
      const x = player.x + dx;
      const y = player.y + dy;
      if (['.', 'G'].includes(tankCell(state, x, y)) && tankAt(state, x, y) < 0) {
        player.x = x;
        player.y = y;
      }
    }
    // one shell in the air per tank, like in the original
    if (fire && player.cool <= 0 && !state.bullets.some((bullet) => bullet.owner === seat)) {
      state.bullets.push({ x: player.x, y: player.y, dir: fire, owner: seat });
      player.cool = 1;
    }
  }
  for (const player of state.players) {
    if (player.cool > 0) player.cool -= 1;
    if (player.shield > 0) player.shield -= 1;
  }

  tankMoveBullets(state);
  if (state.over) return;

  if (state.tick >= TANK_MAX_TICKS) {
    // time is up: the most lives win, then the most kills; equal tanks share the pot
    const alive = state.players.map((player, seat) => ({ seat, player })).filter((item) => item.player.alive);
    const best = Math.max(...alive.map((item) => item.player.lives * 100 + item.player.kills));
    tankFinish(state, alive.filter((item) => item.player.lives * 100 + item.player.kills === best).map((item) => item.seat));
  }
}

/** Runs the ticks that are due; `inputs` are the newest wishes as { seat, t, move, fire }. Returns true if anything changed. */
export function tankAdvance(state, now, inputs = []) {
  if (state.over || now < state.nextTick) return false;
  let first = true;
  let guard = 0;
  while (!state.over && now >= state.nextTick && guard < 6) {
    if (first) {
      for (const input of inputs) {
        const player = state.players[input.seat];
        if (player && input.t > player.seen) {
          tankInput(state, input.seat, input.move, input.fire);
          player.seen = input.t;
        }
      }
      first = false;
    }
    tankStep(state);
    state.nextTick += TANK_TICK_MS;
    guard += 1;
  }
  if (!state.over && now >= state.nextTick) state.nextTick = now + TANK_TICK_MS; // far behind: do not try to catch up
  return true;
}

export function tankForfeit(state, seat) {
  const player = state.players[seat];
  if (!player || !player.alive || state.over) return;
  player.alive = false;
  player.lives = 0;
  tankNote(state, { type: 'left', victim: seat });
  tankCheckEnd(state);
}

/** What one player sees: everything, except enemy tanks hiding in the bushes (unless right next to him). */
export function tankView(state, key, now) {
  const me = state.players.findIndex((player) => player.key === key);
  const watcher = me >= 0 && state.players[me].alive ? state.players[me] : null;
  return {
    map: state.map,
    mapName: state.mapName,
    grid: state.grid,
    tick: state.tick,
    countdown: Math.max(0, TANK_COUNTDOWN - state.tick),
    timeLeft: Math.max(0, TANK_MAX_TICKS - state.tick),
    tickMs: TANK_TICK_MS,
    now,
    nextTick: state.nextTick,
    me,
    stake: state.stake,
    pot: state.pot,
    over: state.over,
    winners: state.winners,
    bullets: state.bullets.map((bullet) => ({ x: bullet.x, y: bullet.y, dir: bullet.dir, owner: bullet.owner })),
    players: state.players.map((player, seat) => {
      const base = { seat, name: player.name, alive: player.alive, lives: player.lives, kills: player.kills, me: seat === me };
      if (!player.alive) return base;
      const hidden = watcher && seat !== me && tankCell(state, player.x, player.y) === 'G' && (Math.abs(player.x - watcher.x) > 1 || Math.abs(player.y - watcher.y) > 1);
      return hidden ? { ...base, hidden: true } : { ...base, x: player.x, y: player.y, dir: player.dir, shield: player.shield };
    }),
    log: state.log
  };
}
