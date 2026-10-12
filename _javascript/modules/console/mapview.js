/**
 * Interactive map in the terminal: the zones of a post's `interactive_map` drawn with characters.
 * Arrow keys / Tab / digits (or the mouse) pick a zone, Enter opens its page, Esc leaves.
 */

import { ESC, c } from './ansi';

const KEY = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  shiftTab: `${ESC}[Z`
};

// palette indices, so zones follow the terminal theme; a zone with its own `color:` gets that exact colour
const PALETTE = [31, 33, 36, 32, 35, 34];

function parsePoints(text) {
  return String(text)
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite));
}

function inside(polygon, x, y) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function colorOf(zone, index) {
  const hex = /^#([0-9a-f]{6})$/i.exec(zone.color ?? '');
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  }
  return String(PALETTE[index % PALETTE.length]);
}

export function playMap(shell, article) {
  return new Promise((resolve) => {
    const zones = article.zones.map((zone, index) => ({
      ...zone,
      polygon: parsePoints(zone.points),
      sgr: colorOf(zone, index)
    }));

    const cols = shell.term.cols ?? 80;
    const rows = shell.term.rows ?? 24;
    const legend = zones.length;

    // the map is square on the page and cells are about twice as tall as wide: height = width / 2
    let height = Math.min(Math.floor((Math.min(cols - 4, 100)) / 2), rows - legend - 7);
    if (height < 6) {
      shell.println(c.red('Окно слишком маленькое для карты.') + c.grey(' Увеличьте его или сверните панели.'));
      resolve();
      return;
    }
    const width = height * 2;
    const left = 3;
    const top = 3;

    // which zone each cell belongs to
    const grid = Array.from({ length: height }, (_, j) =>
      Array.from({ length: width }, (_, i) => {
        const x = ((i + 0.5) / width) * 100;
        const y = ((j + 0.5) / height) * 100;
        return zones.findIndex((zone) => zone.polygon.length > 2 && inside(zone.polygon, x, y));
      })
    );

    // where the zone's number is drawn: the zone cell nearest to its average position
    zones.forEach((zone, index) => {
      let sx = 0;
      let sy = 0;
      let n = 0;
      grid.forEach((line, j) =>
        line.forEach((id, i) => {
          if (id === index) {
            sx += i;
            sy += j;
            n += 1;
          }
        })
      );
      zone.cx = n ? sx / n : 0;
      zone.cy = n ? sy / n : 0;
      let best = Infinity;
      grid.forEach((line, j) =>
        line.forEach((id, i) => {
          const d = (i - zone.cx) ** 2 + (j - zone.cy) ** 2;
          if (id === index && d < best) {
            best = d;
            zone.labelAt = [i, j];
          }
        })
      );
    });

    let selected = 0;
    const at = (row, col) => `${ESC}[${row};${col}H`;

    const edge = (i, j, id) =>
      [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0]
      ].some(([dx, dy]) => (grid[j + dy]?.[i + dx] ?? -1) !== id);

    function draw() {
      let out = `${ESC}[2J${at(1, left)}${c.bold(c.red('КАРТА'))}  ${c.amber(article.title)}`;

      for (let j = 0; j < height; j += 1) {
        let line = '';
        for (let i = 0; i < width; i += 1) {
          const id = grid[j][i];
          const zone = zones[id];
          if (!zone) {
            line += ' ';
          } else if (zone.labelAt[0] === i && zone.labelAt[1] === j) {
            line += `${ESC}[1;${id === selected ? '97;7' : '97'}m${(id + 1) % 10}${ESC}[0m`;
          } else if (edge(i, j, id)) {
            line += `${ESC}[${id === selected ? '1;' : ''}${zone.sgr}m█${ESC}[0m`;
          } else {
            line += id === selected ? `${ESC}[${zone.sgr}m▒${ESC}[0m` : c.grey('·');
          }
        }
        out += at(top + j, left) + line;
      }

      let row = top + height + 1;
      zones.forEach((zone, index) => {
        const mark = index === selected ? c.bright('►') : ' ';
        const label = index === selected ? `${ESC}[1;${zone.sgr}m${zone.title}${ESC}[0m` : c.grey(zone.title);
        out += `${at(row, left - 1)}${mark} ${c.bright(String((index + 1) % 10))} ${label}`;
        row += 1;
      });

      // the chosen zone's text, as many lines as fit
      const free = rows - row - 1;
      const lines = shell
        .wrap(zones[selected].text ?? '')
        .split('\n')
        .slice(0, Math.max(1, free));
      lines.forEach((text, i) => {
        out += `${at(row + i, left)}${c.red(text)}`;
      });

      const link = zones[selected].link ? '  Enter — открыть страницу' : '';
      out += `${at(rows, left)}${c.grey(`←→↑↓ / Tab — выбор · клик · Esc — выход${link}`)}`;
      shell.raw(out);
    }

    function move(dx, dy) {
      const from = zones[selected];
      let best = -1;
      let bestScore = Infinity;
      zones.forEach((zone, index) => {
        if (index === selected) return;
        const ax = (zone.cx - from.cx) / 2; // cells are twice as tall as wide
        const ay = zone.cy - from.cy;
        const along = dx ? ax * dx : ay * dy;
        const across = dx ? Math.abs(ay) : Math.abs(ax);
        if (along <= 0) return;
        const score = along + across * 2;
        if (score < bestScore) {
          bestScore = score;
          best = index;
        }
      });
      if (best >= 0) select(best);
    }

    function select(index) {
      if (index === selected || index < 0 || index >= zones.length) return;
      selected = index;
      draw();
    }

    // mouse: hover and click pick the zone under the pointer
    const grid$ = shell.screen?.querySelector('.term-grid') ?? shell.screen;
    function zoneAt(event) {
      if (!grid$) return -1;
      const box = grid$.getBoundingClientRect();
      const col = Math.floor((event.clientX - box.left) / (box.width / cols)) + 1;
      const row = Math.floor((event.clientY - box.top) / (box.height / rows)) + 1;
      const i = col - left;
      const j = row - top;
      return grid[j]?.[i] ?? -1;
    }

    let frame = 0;
    const onMove = (event) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const id = zoneAt(event);
        if (id >= 0) select(id);
      });
    };
    const onClick = (event) => {
      const id = zoneAt(event);
      if (id >= 0) select(id);
    };
    shell.screen?.addEventListener('pointermove', onMove);
    shell.screen?.addEventListener('click', onClick);

    function finish() {
      cancelAnimationFrame(frame);
      shell.screen?.removeEventListener('pointermove', onMove);
      shell.screen?.removeEventListener('click', onClick);
      shell.setKeyHandler(null);
      shell.raw(`${ESC}[?25h${ESC}[?1049l`);
      resolve();
    }

    shell.setKeyHandler((key) => {
      if (key === ESC || /^[qQйЙ]$/.test(key)) finish();
      else if (key === KEY.left) move(-1, 0);
      else if (key === KEY.right) move(1, 0);
      else if (key === KEY.up) move(0, -1);
      else if (key === KEY.down) move(0, 1);
      else if (key === '\t') select((selected + 1) % zones.length);
      else if (key === KEY.shiftTab) select((selected + zones.length - 1) % zones.length);
      else if (/^[1-9]$/.test(key)) select(Number(key) - 1);
      else if (key === '\r' && zones[selected].link) {
        finish();
        window.location.href = zones[selected].link;
      }
    });

    shell.raw(`${ESC}[?1049h${ESC}[?25l`);
    draw();
  });
}

