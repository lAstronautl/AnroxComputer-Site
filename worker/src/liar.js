/**
 * «Колода лжеца» — карточная игра на несколько игроков (по мотивам Liar's Bar).
 * Чистая логика без базы: состояние партии — обычный объект, который сервер хранит в D1 как JSON.
 * Руки игроков и положения пуль знает только сервер, `liarView` отдаёт игроку только то, что ему положено видеть.
 */

export const LIAR_TURN_MS = 40000; // время на ход; потом ход делается за игрока
export const LIAR_AFK_LIMIT = 3; // сколько ходов подряд можно пропустить, прежде чем вылетишь
export const LIAR_HAND = 5;
export const LIAR_LOG = 40;
const TABLE_CARDS = ['Q', 'K', 'A'];

function shuffle(list, rng) {
  const cards = [...list];
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

const aliveSeats = (state) => state.players.map((player, seat) => (player.alive ? seat : -1)).filter((seat) => seat >= 0);

export function nextAlive(state, seat) {
  const count = state.players.length;
  for (let step = 1; step <= count; step += 1) {
    const candidate = (seat + step) % count;
    if (state.players[candidate].alive) return candidate;
  }
  return seat;
}

const note = (state, event, now) => {
  state.log.push({ t: now, ...event });
  if (state.log.length > LIAR_LOG) state.log.splice(0, state.log.length - LIAR_LOG);
};

/** A new game: seats in the order given, a secret bullet position in every revolver. */
export function liarStart(players, stake, rng, now) {
  const state = {
    round: 0,
    stake,
    pot: stake * players.length,
    players: players.map((player) => ({ key: player.key, name: player.name, alive: true, hand: [], pulls: 0, bullet: Math.floor(rng() * 6), idle: 0 })),
    table: 'A',
    turn: 0,
    last: null,
    deadline: 0,
    log: [],
    winner: null
  };
  newRound(state, 0, rng, now);
  return state;
}

function newRound(state, starter, rng, now) {
  const deck = shuffle([...Array(6).fill('Q'), ...Array(6).fill('K'), ...Array(6).fill('A'), 'J', 'J'], rng);
  for (const player of state.players) player.hand = [];
  for (let round = 0; round < LIAR_HAND; round += 1) {
    for (const player of state.players) if (player.alive) player.hand.push(deck.pop());
  }
  state.round += 1;
  state.table = TABLE_CARDS[Math.floor(rng() * TABLE_CARDS.length)];
  state.last = null;
  state.turn = state.players[starter].alive ? starter : nextAlive(state, starter);
  state.deadline = now + LIAR_TURN_MS;
  note(state, { type: 'round', round: state.round, table: state.table, starter: state.turn }, now);
}

function finishIfAlone(state, now) {
  const alive = aliveSeats(state);
  if (alive.length === 1) {
    state.winner = alive[0];
    state.deadline = 0;
    note(state, { type: 'win', seat: alive[0], pot: state.pot }, now);
    return true;
  }
  return false;
}

function error(code) {
  const failure = new Error(code);
  failure.code = code;
  return failure;
}

/** The player puts 1–3 cards face down and says they are the table card. */
export function liarPlay(state, seat, indexes, rng, now) {
  if (state.winner !== null) throw error('over');
  if (seat !== state.turn) throw error('not-your-turn');
  const player = state.players[seat];
  const picked = [...new Set(indexes)];
  if (picked.length < 1 || picked.length > 3 || picked.length !== indexes.length || picked.some((i) => !Number.isInteger(i) || i < 0 || i >= player.hand.length)) {
    throw error('bad-cards');
  }
  const cards = picked.map((i) => player.hand[i]);
  player.hand = player.hand.filter((_, i) => !picked.includes(i));
  player.idle = 0;
  state.last = { seat, cards, count: cards.length };
  note(state, { type: 'play', seat, count: cards.length }, now);
  state.turn = nextAlive(state, seat);
  state.deadline = now + LIAR_TURN_MS;
  // a player with an empty hand has nothing to play: he has to call the previous player a liar
  if (state.players[state.turn].hand.length === 0) liarCall(state, state.turn, rng, now, true);
}

/** "Лжец!": the last cards are shown; the loser of the dispute pulls the trigger of his own revolver. */
export function liarCall(state, seat, rng, now, forced = false) {
  if (state.winner !== null) throw error('over');
  if (seat !== state.turn) throw error('not-your-turn');
  if (!state.last) throw error('nothing-to-call');
  const caller = seat;
  const accused = state.last.seat;
  const cards = state.last.cards;
  const truth = cards.every((card) => card === state.table || card === 'J');
  const loser = truth ? caller : accused;
  state.players[caller].idle = forced ? state.players[caller].idle : 0;
  note(state, { type: 'liar', caller, accused, cards, truth, loser, forced, table: state.table }, now);

  const victim = state.players[loser];
  const fired = victim.pulls === victim.bullet;
  victim.pulls += 1;
  note(state, { type: 'shot', seat: loser, pull: victim.pulls, fired }, now);
  if (fired) {
    victim.alive = false;
    victim.hand = [];
    note(state, { type: 'out', seat: loser, reason: 'shot' }, now);
    if (finishIfAlone(state, now)) return;
  }
  newRound(state, loser, rng, now);
}

/** Leaving a running game: the player is out and his stake stays in the pot. */
export function liarForfeit(state, seat, reason, rng, now) {
  const player = state.players[seat];
  if (!player || !player.alive || state.winner !== null) return;
  player.alive = false;
  player.hand = [];
  note(state, { type: 'out', seat, reason }, now);
  if (finishIfAlone(state, now)) return;
  newRound(state, nextAlive(state, seat), rng, now);
}

/** Nobody acts for too long: the game plays the first card for the player, and kicks out those who keep sleeping. */
export function liarTimeout(state, rng, now) {
  if (state.winner !== null || !state.deadline || now <= state.deadline) return false;
  const seat = state.turn;
  const player = state.players[seat];
  const skipped = player.idle + 1;
  if (skipped >= LIAR_AFK_LIMIT) {
    liarForfeit(state, seat, 'afk', rng, now);
    return true;
  }
  if (player.hand.length > 0) liarPlay(state, seat, [0], rng, now);
  else liarCall(state, seat, rng, now, true);
  player.idle = skipped; // a move made for the player must not look like his own
  return true;
}

/** What one player may see: his own hand, the others' card counts, revolver wear, the public log. */
export function liarView(state, key, now) {
  const me = state.players.findIndex((player) => player.key === key);
  const lastBack = state.last ? { seat: state.last.seat, count: state.last.count } : null;
  return {
    round: state.round,
    stake: state.stake,
    pot: state.pot,
    table: state.winner === null ? state.table : null,
    turn: state.winner === null ? state.turn : null,
    deadline: state.deadline,
    now,
    me,
    hand: me >= 0 ? state.players[me].hand : [],
    last: lastBack,
    winner: state.winner,
    players: state.players.map((player, seat) => ({ name: player.name, seat, alive: player.alive, cards: player.hand.length, pulls: player.pulls, me: seat === me })),
    log: state.log
  };
}
