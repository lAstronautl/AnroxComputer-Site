/**
 * The АнКо exchange: a live full-screen market in the console, plus the wallet card, rating and relief payment.
 * Prices and trades are decided by the server (see worker/src/economy.js); this file only draws them.
 * The balance (крипто-енды, КЕ) is the same one the casino plays with.
 */

import { ESC, c, visibleLength } from './ansi';
import { KEY, UNIT, at, barChart, sgr, box, clip, errorText, fmt, isBack, isEnter, money, openScreen, pad, percent, quote, signed, spark, tooSmall, toneOf } from './tui';

const POLL_MS = 2500;
const CHART_HINTS = 3;

// every corporation has its own colour, so the companies of one group are easy to tell apart
const GROUP_TONES = { Anrox: '33', MiliGalax: '36', StarDust: '35', Subea: '94' };
// how strongly buyers (▲) or sellers (▼) push the price right now
function demandMark(value = 0) {
  const level = Math.abs(value) > 0.15 ? 3 : Math.abs(value) > 0.06 ? 2 : Math.abs(value) > 0.015 ? 1 : 0;
  if (!level) return c.grey('··');
  return (value > 0 ? c.green : c.red)((value > 0 ? '▲' : '▼').repeat(level));
}

const groupTone = (group) => GROUP_TONES[group] ?? '37';

/* ---------- wallet ---------- */

export async function showWallet(shell) {
  const result = await shell.backend.call('GET', '/api/wallet');
  if (result.error) {
    shell.println(c.red(errorText(result.error)));
    return;
  }

  const width = Math.min(shell.term.cols ?? 80, 46) - 1;
  const prices = new Map(result.assets.map((asset) => [asset.id, asset]));
  const body = [
    '',
    `  ${c.grey('Баланс  ')}  ${c.bold(c.amber(money(result.balance)))}`,
    `  ${c.grey('Портфель')}  ${money(result.worth)}`,
    `  ${c.grey('Всего   ')}  ${c.bold(c.bright(money(result.balance + result.worth)))}`
  ];
  if (result.holdings.length) {
    body.push('', `  ${c.red('── бумаги ' + '─'.repeat(Math.max(2, width - 14)))}`);
    for (const item of result.holdings) {
      const now = prices.get(item.asset);
      const value = Math.floor((now?.price ?? 0) * item.qty);
      body.push(`  ${c.amber(item.asset.padEnd(5))} ${String(item.qty).padStart(4)} шт  ${pad(money(value), 11, 'right')}  ${toneOf(value - item.cost)(pad(signed(value - item.cost), 7, 'right'))}`);
    }
  }
  body.push('');

  shell.println('');
  for (const line of box(width, `КРИПТО-ЕНДЫ · ${shell.user.name}`, body)) shell.println(line);
  shell.println(c.grey(`  ${c.amber('market')} — биржа · ${c.amber('casino')} — казино · ${c.amber('top')} — рейтинг`));
}

export async function showTop(shell) {
  const result = await shell.backend.call('GET', '/api/rich');
  if (result.error) {
    shell.println(c.red(errorText(result.error)));
    return;
  }
  if (!result.top.length) {
    shell.println(c.grey('Рейтинг пока пуст: никто не заходил на биржу.'));
    return;
  }

  const width = Math.min(shell.term.cols ?? 80, 46) - 1;
  const body = [''];
  result.top.forEach((item, index) => {
    const place = [c.amber('1'), c.bright('2'), c.red('3')][index] ?? c.grey(String(index + 1));
    const name = item.me ? c.bold(c.bright(item.name)) : item.name;
    body.push(`  ${place}${' '.repeat(index > 8 ? 0 : 1)} ${pad(clip(name, 18), 18)} ${pad(c.amber(money(item.worth)), width - 28, 'right')}`);
  });
  body.push('');
  shell.println('');
  for (const line of box(width, 'САМЫЕ БОГАТЫЕ СОТРУДНИКИ', body)) shell.println(line);
}

export async function claimDole(shell) {
  const result = await shell.backend.call('POST', '/api/wallet/dole');
  if (result.error === 'dole-wait') {
    const minutes = Math.ceil((result.wait ?? 0) / 60000);
    shell.println(c.red(`Пособие уже выдавали. Следующее — через ${minutes} мин.`));
  } else if (result.error) {
    shell.println(c.red(errorText(result.error)));
  } else {
    shell.println(c.green(`Корпорация выплатила пособие: +${money(result.dole)}. Баланс: ${money(result.balance)}.`));
  }
}

/* ---------- what a trade costs (the same arithmetic as the server) ---------- */

// a big order moves the price and is filled at the average of the price before and after
function quoteTrade(data, asset, side, qty) {
  const impact = Math.min(data.maxImpact ?? 0.07, (asset.price * qty) / (data.liquidity ?? 20000));
  const price = asset.price * Math.exp(side === 'buy' ? impact / 2 : -impact / 2);
  return side === 'buy' ? Math.ceil(price * qty * (1 + data.fee)) : Math.floor(price * qty * (1 - data.fee));
}

// the most the player can buy; a little spare for a price that ticks while the order is on its way
function maxBuy(data, asset) {
  let low = 0;
  let high = Math.floor(data.balance / asset.price) + 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (quoteTrade(data, asset, 'buy', mid) * 1.004 <= data.balance) low = mid;
    else high = mid - 1;
  }
  return low;
}

/* ---------- market editor (top level only) ---------- */

export const EDIT_HELP = [
  'shock <ТИКЕР> <±%>              новость: резкий скачок цены, потом затухает',
  'base <ТИКЕР> <цена>             новый базовый уровень цены (насовсем)',
  'vol <ТИКЕР> <0.01–2>            размах колебаний',
  'add <ТИКЕР> "Название" <группа> <вид> <цена> [размах]   новая компания',
  'remove <ТИКЕР>                  снять компанию (акционерам вернут вложенное)',
  'reset <ТИКЕР>                   вернуть исходные настройки'
];

const EDIT_OPS = { shock: 'shock', base: 'base', vol: 'vol', add: 'add', remove: 'remove', reset: 'reset', новость: 'shock', цена: 'base', размах: 'vol', добавить: 'add', снять: 'remove', сброс: 'reset' };

/** Runs one editor command (`shock GNG +20`); returns the line to show the editor. */
export async function runMarketEdit(shell, args) {
  const op = EDIT_OPS[(args[0] ?? '').toLowerCase()];
  if (!op || !args[1]) return { error: true, text: 'Формат: shock | base | vol | add | remove | reset <ТИКЕР> …  (marketedit — подсказка)' };

  const body = { op, asset: args[1] };
  if (op === 'shock' || op === 'base' || op === 'vol') {
    body.value = Number(String(args[2] ?? '').replace(',', '.').replace('%', ''));
    if (!Number.isFinite(body.value)) return { error: true, text: 'Нужно число.' };
  } else if (op === 'add') {
    Object.assign(body, { name: args[2], group: args[3], kind: args[4], base: Number(args[5]), vol: args[6] === undefined ? 0.3 : Number(args[6]) });
    if (!body.name || !Number.isFinite(body.base)) return { error: true, text: 'add <ТИКЕР> "Название" <группа> <вид> <цена> [размах]' };
  }

  const result = await shell.backend.call('POST', '/api/market/edit', body);
  if (result.error) return { error: true, text: errorText(result.error) };
  return { error: false, text: `Готово: ${result.summary}`, assets: result.assets };
}

export async function cmdMarketEdit(shell, args) {
  if (!args.length || args[0] === 'list') {
    const result = await shell.backend.call('GET', '/api/market');
    if (result.error) {
      shell.println(c.red(errorText(result.error)));
      return;
    }
    if (!result.editor) {
      shell.println(c.red(errorText('forbidden')));
      return;
    }
    shell.println(c.bold(c.red('Редактор рынка')));
    for (const line of EDIT_HELP) shell.println(`  ${c.amber(line.slice(0, 30))}${c.grey(line.slice(30))}`);
    shell.println('');
    shell.println(c.grey(`  Сейчас на бирже ${result.assets.length} компаний: ${result.assets.map((asset) => asset.id).join(' ')}`));
    shell.println(c.grey('  Правки можно делать и прямо на экране биржи: клавиша E.'));
    return;
  }
  const outcome = await runMarketEdit(shell, args);
  shell.println(outcome.error ? c.red(outcome.text) : c.green(outcome.text));
}

/* ---------- trade journal ---------- */

const clock = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour12: false });

// "who bought or sold what, how many, at what price and where the price stood against six minutes ago"
function tradeRow(trade, me, selectedId) {
  const mine = trade.name.toLowerCase() === me.toLowerCase();
  const time = clock(trade.t);
  const name = pad(clip(trade.name, 8), 8);
  const rest = `${pad(trade.asset, 5)}${pad(`×${trade.qty}`, 6, 'right')}${pad(quote(trade.price), 9, 'right')}`;
  const pct = pad(percent(trade.pct), 8, 'right');
  const symbol = trade.side === 'buy' ? '▲' : '▼';
  if (trade.asset !== selectedId && !mine) return c.grey(`${time} ${name} ${symbol}${rest}${pct}`);
  const arrow = trade.side === 'buy' ? c.green(symbol) : c.red(symbol);
  return `${c.grey(time)} ${mine ? c.bold(c.bright(name)) : name} ${arrow}${rest}${toneOf(trade.pct)(pct)}`;
}

const tradeHeader = c.grey('ВРЕМЯ    КТО       БИРЖА   КОЛ     ЦЕНА     Δ6М');

/* ---------- market screen ---------- */

export function playMarket(shell) {
  return new Promise((resolve) => {
    if (tooSmall(shell, 36, 28)) {
      shell.println(c.red('Окно слишком маленькое для биржи.') + c.grey(' Увеличьте его или сверните панели.'));
      resolve();
      return;
    }

    let data = null;
    let selected = 0;
    let order = null; // null — browsing, { side, text } — typing a quantity
    let note = c.grey('Загрузка котировок…');
    let busy = false;
    let timer = 0;
    let clock = 0;
    let fetchedAt = 0;
    let stale = false; // the server runs an older Worker than this page

    const view = openScreen(shell, onKey);
    const { cols } = view;
    const compact = cols < 64;
    const roomy = view.rows >= 46; // room for thin lines between the corporations
    const panelWidth = cols >= 112 ? 48 : 0; // the trade journal sits on the right when the screen is wide
    let showJournal = false; // on narrow screens H swaps the chart for the journal

    const heldOf = (id) => data?.holdings.find((item) => item.asset === id) ?? { qty: 0, cost: 0 };

    function render() {
      const lines = [];
      const width = cols - (panelWidth ? panelWidth + 2 : 0);

      // header
      const title = ` ${c.bold(c.red('◈ БИРЖА АНКО'))} ${c.grey('//')} ${c.red('крипто-енды')}`;
      const balance = data ? `${c.grey('баланс ')}${c.bold(c.amber(money(data.balance)))} ` : '';
      lines.push(`${title}${' '.repeat(Math.max(1, cols - visibleLength(title) - visibleLength(balance)))}${balance}`);
      if (data) {
        const wait = Math.max(0, data.nextIn - (Date.now() - fetchedAt));
        const filled = Math.max(0, Math.min(10, Math.round(10 - (wait / data.tickMs) * 10)));
        lines.push(c.red('━'.repeat(cols - 14)) + c.grey(` обновление ${c.red('▰'.repeat(filled))}${'▱'.repeat(10 - filled)}`).slice(0, 200));
      } else {
        lines.push(c.red('━'.repeat(cols)));
      }

      if (!data) {
        lines.push('', `  ${note}`);
        return lines;
      }

      // price list
      lines.push(
        compact
          ? c.grey(` ${pad('', 2)}${pad('ТИКЕР', 6)}${pad('ЦЕНА', 9, 'right')}${pad('Δ6м', 8, 'right')}  ТРЕНД        СПР ПОРТФ.`)
          : c.grey(`   ${pad('ТИКЕР', 6)}${pad('АКТИВ', 22)}${pad('ЦЕНА', 9, 'right')}${pad('Δ6м', 9, 'right')}   ТРЕНД          СПРОС  ПОРТФЕЛЬ`)
      );
      data.assets.forEach((asset, index) => {
        if (roomy && index > 0 && asset.group !== data.assets[index - 1].group) lines.push(c.grey(` ${'┄'.repeat(width - 2)}`));
        const first = asset.history[0];
        const change = ((asset.price - first) / first) * 100;
        const held = heldOf(asset.id);
        const mark = index === selected ? c.bold(c.red('►')) : ' ';
        const ticker = index === selected ? c.bold(c.bright(pad(asset.id, 6))) : sgr(groupTone(asset.group), pad(asset.id, 6));
        const trend = spark(asset.history, compact ? 8 : 14);
        const position = held.qty ? `${c.bright(String(held.qty))}${c.grey(' шт')}` : c.grey('—');
        const row = compact
          ? ` ${mark} ${ticker}${pad(quote(asset.price), 9, 'right')}${toneOf(change)(pad(percent(change), 8, 'right'))}  ${trend}  ${pad(demandMark(asset.demand), 3)} ${position}`
          : ` ${mark} ${ticker}${pad(index === selected ? c.bright(asset.name) : asset.name, 22)}${pad(quote(asset.price), 9, 'right')}${toneOf(change)(pad(percent(change), 9, 'right'))}   ${trend}   ${pad(demandMark(asset.demand), 5)}  ${position}`;
        lines.push(row);
      });

      // selected asset: facts + chart
      const asset = data.assets[selected];
      const held = heldOf(asset.id);
      const high = Math.max(...asset.history);
      const low = Math.min(...asset.history);
      lines.push(c.red('─'.repeat(width)));
      lines.push(` ${c.bold(sgr(groupTone(asset.group), asset.id))} ${c.grey('·')} ${asset.name} ${c.grey(`(${asset.group} · ${asset.kind})`)}   ${c.grey('макс')} ${quote(high)}  ${c.grey('мин')} ${quote(low)}   ${c.grey('спрос')} ${demandMark(asset.demand)} ${toneOf(asset.demand)(percent(asset.demand * 100))}`);
      if (held.qty) {
        const value = Math.floor(asset.price * held.qty);
        lines.push(` ${c.grey('позиция')} ${held.qty} шт · ${c.grey('вложено')} ${money(held.cost)} · ${c.grey('сейчас')} ${money(value)} · ${toneOf(value - held.cost)(signed(value - held.cost) + ' ' + UNIT)}`);
      } else {
        lines.push(c.grey(` позиции нет · комиссия ${Math.round(data.fee * 100)}% · покупки двигают цену вверх, продажи — вниз`));
      }

      const chartHeight = Math.max(4, view.rows - lines.length - CHART_HINTS - 2);
      if (showJournal && !panelWidth) {
        lines.push(c.red('─'.repeat(width)), ` ${c.bold(c.red('ИСТОРИЯ СДЕЛОК'))}  ${c.grey('все игроки')}`, ` ${tradeHeader}`);
        const room = view.rows - lines.length - CHART_HINTS + 1;
        for (const trade of (data.trades ?? []).slice(0, Math.max(3, room))) lines.push(` ${tradeRow(trade, shell.user.name, asset.id)}`);
        if (!(data.trades ?? []).length) lines.push(c.grey(' пока никто не торговал'));
        while (lines.length < view.rows - CHART_HINTS + 1) lines.push('');
      } else {
        const axis = 8;
        const chart = barChart(asset.history, width - axis - 2, chartHeight, { min: low * 0.985, max: high * 1.015, tone: asset.price >= asset.history[0] ? '32' : '31' });
        chart.forEach((line, index) => {
          const label = index === 0 ? quote(high) : index === chart.length - 1 ? quote(low) : index === Math.floor(chart.length / 2) ? quote((high + low) / 2) : '';
          lines.push(`${c.grey(pad(label, axis, 'right'))} ${c.red('│')}${line}`);
        });
        lines.push(`${' '.repeat(axis)} ${c.red('└' + '─'.repeat(width - axis - 2))}`);
      }

      // the journal on the right of the whole screen
      if (panelWidth) {
        const column = width + 3;
        const panel = [c.bold(c.red('ИСТОРИЯ СДЕЛОК')), c.red('─'.repeat(panelWidth)), tradeHeader];
        const trades = data.trades ?? [];
        for (const trade of trades) panel.push(tradeRow(trade, shell.user.name, asset.id));
        if (!trades.length) panel.push(c.grey('пока никто не торговал'));
        const last = lines.length - 1;
        panel.slice(0, last - 1).forEach((text, i) => {
          lines[i + 2] += at(i + 3, column) + text;
        });
      }

      // footer
      if (order?.side === 'edit') {
        lines.push(` ${c.bold(c.red('РЕДАКТОР РЫНКА ›'))} ${order.text}${c.inverse(' ')}`);
        lines.push(c.grey(' shock GNG +20 · base SUBE 150 · vol ENDI 0.9 · add NEWC "Имя" Группа акции 50 · remove NEWC · reset GNG · Esc'));
      } else if (order) {
        const qty = Number(order.text || 0);
        const total = quoteTrade(data, asset, order.side, qty);
        const verb = order.side === 'buy' ? c.green('КУПИТЬ') : c.red('ПРОДАТЬ');
        lines.push(` ${verb} ${c.bold(c.bright(asset.id))} × ${c.inverse(` ${order.text || '0'} `)}  ${c.grey('≈')} ${c.amber(money(total))}`);
        const max = order.side === 'buy' ? maxBuy(data, asset) : held.qty;
        lines.push(c.grey(` цифры — количество · M — максимум (${fmt(max)}) · Enter — подтвердить · Esc — отмена`));
      } else {
        lines.push(stale ? ` ${c.bold(c.red('Сервер биржи устарел:'))} ${c.amber('вставьте свежий worker/bundle/worker.js в Cloudflare и нажмите Deploy')}` : ` ${note}`);
        lines.push(c.grey(compact ? ' ↑↓ · B куп. · S прод. · H история · Esc' : ` ↑↓ выбор · B купить · S продать${panelWidth ? '' : ' · H история сделок'}${data.editor ? ' · E править рынок' : ''} · Esc выход`));
      }
      return lines;
    }

    function paint() {
      view.paint(render());
    }

    async function refresh() {
      if (busy) return;
      busy = true;
      const result = await shell.backend.call('GET', '/api/market');
      busy = false;
      if (result.error) {
        note = c.red(errorText(result.error));
      } else {
        data = result;
        // an old Worker does not know the new companies and demand: say so instead of drawing "undefined"
        data.assets = data.assets.map((asset) => ({ ...asset, group: asset.group ?? 'Биржа', demand: asset.demand ?? 0 }));
        stale = !data.assets.some((asset) => asset.id === 'MGLX');
        fetchedAt = Date.now();
        if (result.refunded) note = c.amber(`Компании, снятые с биржи, выкуплены по цене покупки: +${money(result.refunded)}`);
        else if (note === c.grey('Загрузка котировок…')) note = c.grey('Цены обновляются каждые несколько секунд.');
      }
      paint();
    }

    async function submit() {
      const asset = data.assets[selected];
      const qty = Number(order.text);
      if (!qty) {
        order = null;
        paint();
        return;
      }
      const { side } = order;
      busy = true;
      note = c.grey('Заявка отправлена…');
      order = null;
      paint();
      const result = await shell.backend.call('POST', '/api/market/trade', { asset: asset.id, side, qty });
      busy = false;
      if (result.error) {
        note = c.red(errorText(result.error));
      } else {
        data = { ...data, balance: result.balance, holdings: result.holdings };
        const verb = side === 'buy' ? c.green('Куплено') : c.red('Продано');
        note = `${verb} ${result.trade.qty} × ${asset.id} по ${quote(result.trade.price)} → ${c.amber(money(result.trade.total))}`;
      }
      paint();
    }

    async function runEdit() {
      const text = order.text.trim();
      order = null;
      if (!text) {
        paint();
        return;
      }
      note = c.grey('Применяю…');
      paint();
      const args = [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
      const outcome = await runMarketEdit(shell, args);
      note = outcome.error ? c.red(outcome.text) : c.green(outcome.text);
      void refresh();
      paint();
    }

    function finish() {
      clearInterval(timer);
      clearInterval(clock);
      view.close();
      resolve();
    }

    function onKey(key) {
      if (!data) {
        if (isBack(key)) finish();
        return;
      }
      const asset = data.assets[selected];
      const held = heldOf(asset.id);

      if (order?.side === 'edit') {
        if (key === ESC) order = null;
        else if (isEnter(key)) {
          void runEdit();
          return;
        } else if (key === '\x7f' || key === '\b') order.text = order.text.slice(0, -1);
        else if (key.length === 1 && key >= ' ' && order.text.length < 90) order.text += key;
        paint();
        return;
      }

      if (order) {
        if (key === ESC) order = null;
        else if (isEnter(key)) {
          void submit();
          return;
        } else if (/^[0-9]$/.test(key) && order.text.length < 7) order.text = order.text === '0' ? key : order.text + key;
        else if (key === '\x7f' || key === '\b') order.text = order.text.slice(0, -1);
        else if (/^[mMьЬ]$/.test(key)) {
          const max = order.side === 'buy' ? maxBuy(data, asset) : held.qty;
          order.text = String(Math.max(0, max));
        }
        paint();
        return;
      }

      if (isBack(key)) finish();
      else if (key === KEY.up || /^[wцWЦ]$/.test(key)) selected = (selected + data.assets.length - 1) % data.assets.length;
      else if (key === KEY.down || key === '\t') selected = (selected + 1) % data.assets.length;
      else if (/^[bBиИ]$/.test(key) && !busy) order = { side: 'buy', text: '' };
      else if (/^[eEуУ]$/.test(key) && data.editor) order = { side: 'edit', text: '' };
      else if (/^[sSыЫ]$/.test(key) && !busy) {
        if (held.qty) order = { side: 'sell', text: '' };
        else note = c.red('У вас нет этих бумаг.');
      } else if (/^[hHрР]$/.test(key)) showJournal = !showJournal;
      else if (/^[1-9]$/.test(key)) selected = Math.min(data.assets.length - 1, Number(key) - 1);
      shell.sound?.tick?.();
      paint();
    }

    timer = setInterval(refresh, POLL_MS);
    clock = setInterval(paint, 1000);
    paint();
    void refresh();
  });
}

export async function sendMoney(shell, args) {
  const [to, amount, ...note] = args;
  if (!to || !amount) {
    shell.println(c.grey('Использование: pay <имя> <сумма> [сообщение]  — перевод КЕ сотруднику, ему придёт письмо.'));
    return;
  }
  const result = await shell.backend.call('POST', '/api/wallet/send', { to, amount: Number(amount), note: note.join(' ') });
  if (result.error) {
    shell.println(c.red(errorText(result.error)));
    return;
  }
  shell.println(c.green(`Переведено ${money(result.sent.amount)} → ${result.sent.to}. Письмо о переводе отправлено. Баланс: ${money(result.balance)}.`));
}
