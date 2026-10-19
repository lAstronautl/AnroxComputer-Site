/**
 * «Трон» (световые мотоциклы) и «Змейка» для 2–4 игроков: чистая логика без базы.
 * Оба режима идут тактами: игрок лишь задаёт направление, сервер двигает всех сразу.
 * Игра заканчивается, когда остаётся один живой игрок, либо по времени.
 */

export const ARCADE_TICK_MS = 250;
export const ARCADE_COUNTDOWN = 12; // тактов на подготовку
export const ARCADE_LOG = 20;
export const TRON_MAX_TICKS = 480;
export const SNAKE_MAX_TICKS = 480;
export const SNAKE_START_LEN = 3;
export const SOLO_MAX_TICKS = 1200; // five minutes of one-player snake
export const SOLO_PER_FOOD = 2; // crypto-ends per apple
export const SOLO_CAP = 50; // the most one run can pay

const ARC_DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
const ARC_OPPOSITE = { U: 'D', D: 'U', L: 'R', R: 'L' };

const ARC_W = 28;
const ARC_H = 16;

const arcBlank = () => Array.from({ length: ARC_H }, () => '.'.repeat(ARC_W));

function arcCarve(rows, cells) {
  const grid = rows.map((row) => [...row]);
  for (const [x, y] of cells) if (grid[y]?.[x] !== undefined) grid[y][x] = '#';
  return grid.map((row) => row.join(''));
}

const arcRect = (x0, y0, x1, y1) => {
  const cells = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) cells.push([x, y]);
  return cells;
};

/** Seats start in the corners, looking at the middle. */
const ARC_STARTS = [
  { x: 3, y: 3, dir: 'R' },
  { x: ARC_W - 4, y: ARC_H - 4, dir: 'L' },
  { x: ARC_W - 4, y: 3, dir: 'D' },
  { x: 3, y: ARC_H - 4, dir: 'U' }
];

export const ARCADE_MAPS = {
  open: { name: 'Пустошь', rows: arcBlank() },
  pillars: {
    name: 'Колонны',
    rows: arcCarve(arcBlank(), [...arcRect(8, 4, 9, 5), ...arcRect(18, 4, 19, 5), ...arcRect(8, 10, 9, 11), ...arcRect(18, 10, 19, 11), ...arcRect(13, 7, 14, 8)])
  },
  cross: {
    name: 'Крест',
    rows: arcCarve(arcBlank(), [...arcRect(12, 3, 15, 4), ...arcRect(12, 11, 15, 12), ...arcRect(6, 7, 9, 8), ...arcRect(18, 7, 21, 8)])
  }
};

const arcNote = (state, event) => {
  state.log.push({ ...event, tick: state.tick });
  if (state.log.length > ARCADE_LOG) state.log.shift();
};

const arcWall = (state, x, y) => x < 0 || y < 0 || x >= ARC_W || y >= ARC_H || state.grid[y][x] === '#';

function arcBase(kind, players, mapId, stake, now) {
  const id = ARCADE_MAPS[mapId] ? mapId : 'open';
  return {
    kind,
    map: id,
    mapName: ARCADE_MAPS[id].name,
    w: ARC_W,
    h: ARC_H,
    grid: [...ARCADE_MAPS[id].rows],
    tick: 0,
    nextTick: now + ARCADE_TICK_MS,
    stake,
    pot: stake * players.length,
    players: players.map((player, seat) => ({
      key: player.key,
      name: player.name,
      alive: true,
      x: ARC_STARTS[seat].x,
      y: ARC_STARTS[seat].y,
      dir: ARC_STARTS[seat].dir,
      want: ARC_STARTS[seat].dir,
      seen: 0
    })),
    log: [],
    over: false,
    winners: []
  };
}

export function arcadeStart(kind, players, mapId, stake, now, solo = false) {
  const state = arcBase(kind, players, mapId, stake, now);
  state.solo = solo;
  if (kind === 'tron') {
    state.trail = arcBlank(); // the seat digit where a light wall stands
    state.players.forEach((player, seat) => arcTrail(state, player.x, player.y, String(seat)));
  } else {
    state.snakes = state.players.map((player) => {
      const [dx, dy] = ARC_DIRS[player.dir];
      return Array.from({ length: SNAKE_START_LEN }, (_, i) => [player.x - dx * i, player.y - dy * i]); // head first
    });
    state.food = [];
    state.scores = state.players.map(() => 0);
    for (let i = 0; i < 2 + players.length; i += 1) arcFood(state);
  }
  arcNote(state, { type: 'start' });
  return state;
}

function arcTrail(state, x, y, value) {
  const row = [...state.trail[y]];
  row[x] = value;
  state.trail[y] = row.join('');
}

/** A tiny deterministic generator keeps the state reproducible and free of Math.random in the middle of a tick. */
function arcRand(state) {
  state.seed = (Math.imul(state.seed ?? 1234567 + state.tick * 7919, 1103515245) + 12345) >>> 0;
  return state.seed / 4294967296;
}

function arcOccupied(state, x, y) {
  if (state.grid[y][x] === '#') return true;
  if (state.food.some(([fx, fy]) => fx === x && fy === y)) return true;
  return state.snakes.some((snake, seat) => state.players[seat].alive && snake.some(([sx, sy]) => sx === x && sy === y));
}

function arcFood(state) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const x = Math.floor(arcRand(state) * ARC_W);
    const y = Math.floor(arcRand(state) * ARC_H);
    if (!arcOccupied(state, x, y)) {
      state.food.push([x, y]);
      return;
    }
  }
}

/** The player's wish: a direction (a turn back into oneself is ignored). */
export function arcadeInput(state, seat, move) {
  const player = state.players[seat];
  if (!player || !player.alive || state.over || !ARC_DIRS[move]) return;
  if (move !== ARC_OPPOSITE[player.dir]) player.want = move;
}

function arcAlive(state) {
  const alive = state.players.map((player, seat) => (player.alive ? seat : -1)).filter((seat) => seat >= 0);
  return alive;
}

function arcFinish(state, winners) {
  state.over = true;
  state.winners = winners;
  arcNote(state, { type: 'over', winners });
}

function arcKill(state, seat, reason) {
  const player = state.players[seat];
  if (!player.alive) return;
  player.alive = false;
  arcNote(state, { type: 'crash', seat, reason });
  if (state.kind === 'tron') {
    // a dead cycle's wall vanishes, so the arena does not clog up
    state.trail = state.trail.map((row) => [...row].map((ch) => (ch === String(seat) ? '.' : ch)).join(''));
  }
}

export const soloReward = (state) => (state.solo ? Math.min(SOLO_CAP, state.scores[0] * SOLO_PER_FOOD) : 0);

function arcJudge(state, diedNow) {
  if (state.solo) {
    if (!state.players[0].alive || state.tick - ARCADE_COUNTDOWN >= SOLO_MAX_TICKS) arcFinish(state, []);
    return;
  }
  const alive = arcAlive(state);
  if (alive.length === 1) arcFinish(state, alive);
  else if (alive.length === 0) arcFinish(state, diedNow); // everyone fell in the same tick: a draw
  else if (state.tick - ARCADE_COUNTDOWN >= (state.kind === 'tron' ? TRON_MAX_TICKS : SNAKE_MAX_TICKS)) {
    if (state.kind === 'tron') arcFinish(state, alive);
    else {
      const best = Math.max(...alive.map((seat) => state.snakes[seat].length));
      arcFinish(state, alive.filter((seat) => state.snakes[seat].length === best));
    }
  }
}

/** One tick of the match. */
export function arcadeStep(state) {
  if (state.over) return;
  state.tick += 1;
  if (state.tick <= ARCADE_COUNTDOWN) {
    for (const player of state.players) player.dir = player.want;
    if (state.tick === ARCADE_COUNTDOWN) arcNote(state, { type: 'go' });
    return;
  }

  const heads = state.players.map((player) => {
    if (!player.alive) return null;
    player.dir = player.want;
    const [dx, dy] = ARC_DIRS[player.dir];
    return [player.x + dx, player.y + dy];
  });
  const dead = new Map(); // seat -> reason

  if (state.kind === 'tron') {
    heads.forEach((head, seat) => {
      if (!head) return;
      const [x, y] = head;
      if (arcWall(state, x, y)) dead.set(seat, 'wall');
      else if (state.trail[y][x] !== '.') dead.set(seat, 'trail');
    });
  } else {
    const eats = heads.map((head) => head && state.food.some(([fx, fy]) => fx === head[0] && fy === head[1]));
    const solid = new Set();
    state.snakes.forEach((snake, seat) => {
      if (!state.players[seat].alive) return;
      snake.forEach(([sx, sy], i) => {
        if (i === snake.length - 1 && !eats[seat]) return; // the tail moves away
        solid.add(`${sx},${sy}`);
      });
    });
    heads.forEach((head, seat) => {
      if (!head) return;
      if (arcWall(state, head[0], head[1])) dead.set(seat, 'wall');
      else if (solid.has(`${head[0]},${head[1]}`)) dead.set(seat, 'body');
    });
    state.eats = eats;
  }

  // two heads in one cell, or two cycles swapping places: both are lost
  heads.forEach((head, a) => {
    if (!head) return;
    heads.forEach((other, b) => {
      if (a >= b || !other) return;
      const same = head[0] === other[0] && head[1] === other[1];
      const swap = head[0] === state.players[b].x && head[1] === state.players[b].y && other[0] === state.players[a].x && other[1] === state.players[a].y;
      if (same || swap) {
        dead.set(a, 'head');
        dead.set(b, 'head');
      }
    });
  });

  heads.forEach((head, seat) => {
    if (!head || dead.has(seat)) return;
    const player = state.players[seat];
    player.x = head[0];
    player.y = head[1];
    if (state.kind === 'tron') arcTrail(state, head[0], head[1], String(seat));
    else {
      const snake = state.snakes[seat];
      snake.unshift([head[0], head[1]]);
      if (state.eats[seat]) {
        state.food = state.food.filter(([fx, fy]) => fx !== head[0] || fy !== head[1]);
        state.scores[seat] += 1;
        arcFood(state);
      } else snake.pop();
    }
  });
  delete state.eats;
  for (const [seat, reason] of dead) arcKill(state, seat, reason);
  arcJudge(state, [...dead.keys()]);
}

/** Runs the ticks that are due. Steering wishes arrive as inputs [{seat, t, move}]. */
export function arcadeAdvance(state, now, inputs = []) {
  if (state.over || now < state.nextTick) return false;
  let first = true;
  let guard = 0;
  while (!state.over && now >= state.nextTick && guard < 6) {
    if (first) {
      for (const input of inputs) {
        const player = state.players[input.seat];
        if (player && input.t > player.seen) {
          arcadeInput(state, input.seat, input.move);
          player.seen = input.t;
        }
      }
      first = false;
    }
    arcadeStep(state);
    state.nextTick += ARCADE_TICK_MS;
    guard += 1;
  }
  if (!state.over && now >= state.nextTick) state.nextTick = now + ARCADE_TICK_MS;
  return true;
}

export function arcadeForfeit(state, seat) {
  const player = state.players[seat];
  if (!player || !player.alive || state.over) return;
  arcKill(state, seat, 'left');
  if (state.kind === 'snake') state.snakes[seat] = [];
  arcJudge(state, []);
}

export function arcadeView(state, key, now) {
  const base = {
    kind: state.kind,
    map: state.map,
    mapName: state.mapName,
    w: state.w,
    h: state.h,
    grid: state.grid,
    tick: state.tick,
    countdown: Math.max(0, ARCADE_COUNTDOWN - state.tick),
    timeLeft: Math.max(0, (state.solo ? SOLO_MAX_TICKS : state.kind === 'tron' ? TRON_MAX_TICKS : SNAKE_MAX_TICKS) - Math.max(0, state.tick - ARCADE_COUNTDOWN)),
    tickMs: ARCADE_TICK_MS,
    now,
    nextTick: state.nextTick,
    me: state.players.findIndex((player) => player.key === key),
    stake: state.stake,
    pot: state.pot,
    solo: state.solo,
    reward: soloReward(state),
    over: state.over,
    winners: state.winners,
    players: state.players.map((player, seat) => ({
      seat,
      name: player.name,
      alive: player.alive,
      me: player.key === key,
      x: player.x,
      y: player.y,
      dir: player.dir,
      ...(state.kind === 'snake' ? { len: state.snakes[seat].length, score: state.scores[seat] } : {})
    })),
    log: state.log
  };
  if (state.kind === 'tron') return { ...base, trail: state.trail };
  return { ...base, snakes: state.snakes, food: state.food };
}
