/**
 * The АнКо exchange: a live full-screen market in the console, plus the wallet card, rating and relief payment.
 * Prices and trades are decided by the server (see worker/src/economy.js); this file only draws them.
 * The balance (крипто-енды, КЕ) is the same one the casino plays with.
 */

import { ESC, c, visibleLength } from './ansi';
import { KEY, UNIT, barChart, sgr, box, clip, errorText, fmt, isBack, isEnter, money, openScreen, pad, percent, quote, signed, spark, tooSmall, toneOf } from './tui';

const POLL_MS = 2500;
const CHART_HINTS = 3;

// every corporation has its own colour, so the companies of one group are easy to tell apart
const GROUP_TONES = { Anrox: '33', MiliGalax: '36', StarDust: '35', Subea: '94' };
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

    const view = openScreen(shell, onKey);
    const { cols } = view;
    const compact = cols < 64;
    const roomy = view.rows >= 46; // room for thin lines between the corporations

    const heldOf = (id) => data?.holdings.find((item) => item.asset === id) ?? { qty: 0, cost: 0 };

    function render() {
      const lines = [];
      const width = cols;

      // header
      const title = ` ${c.bold(c.red('◈ БИРЖА АНКО'))} ${c.grey('//')} ${c.red('крипто-енды')}`;
      const balance = data ? `${c.grey('баланс ')}${c.bold(c.amber(money(data.balance)))} ` : '';
      lines.push(`${title}${' '.repeat(Math.max(1, width - visibleLength(title) - visibleLength(balance)))}${balance}`);
      if (data) {
        const wait = Math.max(0, data.nextIn - (Date.now() - fetchedAt));
        const filled = Math.max(0, Math.min(10, Math.round(10 - (wait / data.tickMs) * 10)));
        lines.push(c.red('━'.repeat(width - 14)) + c.grey(` тик ${c.red('▰'.repeat(filled))}${'▱'.repeat(10 - filled)}`).slice(0, 200));
      } else {
        lines.push(c.red('━'.repeat(width)));
      }

      if (!data) {
        lines.push('', `  ${note}`);
        return lines;
      }

      // price list
      lines.push(
        compact
          ? c.grey(` ${pad('', 2)}${pad('ТИКЕР', 6)}${pad('ЦЕНА', 9, 'right')}${pad('Δ6м', 8, 'right')}  ТРЕНД        ПОРТФ.`)
          : c.grey(`   ${pad('ТИКЕР', 6)}${pad('АКТИВ', 22)}${pad('ЦЕНА', 9, 'right')}${pad('Δ6м', 9, 'right')}   ТРЕНД          ПОРТФЕЛЬ`)
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
          ? ` ${mark} ${ticker}${pad(quote(asset.price), 9, 'right')}${toneOf(change)(pad(percent(change), 8, 'right'))}  ${trend}  ${position}`
          : ` ${mark} ${ticker}${pad(index === selected ? c.bright(asset.name) : asset.name, 22)}${pad(quote(asset.price), 9, 'right')}${toneOf(change)(pad(percent(change), 9, 'right'))}   ${trend}   ${position}`;
        lines.push(row);
      });

      // selected asset: facts + chart
      const asset = data.assets[selected];
      const held = heldOf(asset.id);
      const high = Math.max(...asset.history);
      const low = Math.min(...asset.history);
      lines.push(c.red('─'.repeat(width)));
      lines.push(` ${c.bold(sgr(groupTone(asset.group), asset.id))} ${c.grey('·')} ${asset.name} ${c.grey(`(${asset.group} · ${asset.kind})`)}   ${c.grey('макс')} ${quote(high)}  ${c.grey('мин')} ${quote(low)}`);
      if (held.qty) {
        const value = Math.floor(asset.price * held.qty);
        lines.push(` ${c.grey('позиция')} ${held.qty} шт · ${c.grey('вложено')} ${money(held.cost)} · ${c.grey('сейчас')} ${money(value)} · ${toneOf(value - held.cost)(signed(value - held.cost) + ' ' + UNIT)}`);
      } else {
        lines.push(c.grey(` позиции нет · комиссия ${Math.round(data.fee * 100)}% с каждой сделки`));
      }

      const chartHeight = Math.max(4, view.rows - lines.length - CHART_HINTS - 2);
      const axis = 8;
      const chart = barChart(asset.history, width - axis - 2, chartHeight, { min: low * 0.985, max: high * 1.015, tone: asset.price >= asset.history[0] ? '32' : '31' });
      chart.forEach((line, index) => {
        const label = index === 0 ? quote(high) : index === chart.length - 1 ? quote(low) : index === Math.floor(chart.length / 2) ? quote((high + low) / 2) : '';
        lines.push(`${c.grey(pad(label, axis, 'right'))} ${c.red('│')}${line}`);
      });
      lines.push(`${' '.repeat(axis)} ${c.red('└' + '─'.repeat(width - axis - 2))}`);

      // footer
      if (order) {
        const qty = Number(order.text || 0);
        const total = order.side === 'buy' ? Math.ceil(asset.price * qty * (1 + data.fee)) : Math.floor(asset.price * qty * (1 - data.fee));
        const verb = order.side === 'buy' ? c.green('КУПИТЬ') : c.red('ПРОДАТЬ');
        lines.push(` ${verb} ${c.bold(c.bright(asset.id))} × ${c.inverse(` ${order.text || '0'} `)}  ${c.grey('≈')} ${c.amber(money(total))}`);
        const max = order.side === 'buy' ? Math.floor(data.balance / (asset.price * (1 + data.fee))) : held.qty;
        lines.push(c.grey(` цифры — количество · M — максимум (${fmt(max)}) · Enter — подтвердить · Esc — отмена`));
      } else {
        lines.push(` ${note}`);
        lines.push(c.grey(compact ? ' ↑↓ выбор · B куп. · S прод. · Esc' : ' ↑↓ выбор · B купить · S продать · W кошелёк · Esc выход'));
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

      if (order) {
        if (key === ESC) order = null;
        else if (isEnter(key)) {
          void submit();
          return;
        } else if (/^[0-9]$/.test(key) && order.text.length < 7) order.text = order.text === '0' ? key : order.text + key;
        else if (key === '\x7f' || key === '\b') order.text = order.text.slice(0, -1);
        else if (/^[mMьЬ]$/.test(key)) {
          const max = order.side === 'buy' ? Math.floor(data.balance / (asset.price * (1 + data.fee))) : held.qty;
          order.text = String(Math.max(0, max));
        }
        paint();
        return;
      }

      if (isBack(key)) finish();
      else if (key === KEY.up || /^[wцWЦ]$/.test(key)) selected = (selected + data.assets.length - 1) % data.assets.length;
      else if (key === KEY.down || key === '\t') selected = (selected + 1) % data.assets.length;
      else if (/^[bBиИ]$/.test(key) && !busy) order = { side: 'buy', text: '' };
      else if (/^[sSыЫ]$/.test(key) && !busy) {
        if (held.qty) order = { side: 'sell', text: '' };
        else note = c.red('У вас нет этих бумаг.');
      } else if (/^[1-9]$/.test(key)) selected = Math.min(data.assets.length - 1, Number(key) - 1);
      shell.sound?.tick?.();
      paint();
    }

    timer = setInterval(refresh, POLL_MS);
    clock = setInterval(paint, 1000);
    paint();
    void refresh();
  });
}
