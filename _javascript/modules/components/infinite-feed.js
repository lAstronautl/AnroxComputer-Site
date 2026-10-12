/**
 * Home page feed: smart tile packing + infinite scroll.
 *
 * Every post is in the page; they are shown a few categories at a time and the next batch appears when the
 * end of the list scrolls into view. The tiles are packed so that rows have no empty slots: a category fills
 * whole rows, its remainder (shorter than a row) is put in the row right below it, and the rest of that row
 * is filled with small categories that fit exactly. Small categories are combined into full rows the same way.
 * Packing depends on the number of columns, so it is redone on resize and when the view is switched.
 */

const BATCH = 6; // minimum number of tiles revealed per step
const root = document.documentElement;

// the subset of groups (by index) whose sizes add up to the largest sum <= limit
function bestFit(pool, limit) {
  let reach = new Map([[0, []]]);
  pool.forEach((group, index) => {
    for (const [sum, picked] of [...reach]) {
      const next = sum + group.cells.length;
      if (next <= limit && (!reach.has(next) || reach.get(next).length > picked.length + 1)) {
        reach.set(next, [...picked, index]);
      }
    }
  });
  const best = Math.max(...reach.keys());
  return reach.get(best);
}

function take(pool, indexes) {
  const taken = indexes.map((index) => pool[index]);
  indexes
    .slice()
    .sort((a, b) => b - a)
    .forEach((index) => pool.splice(index, 1));
  return taken;
}

// units are runs of tiles that stay together: whole rows of a category, or a row of small categories
function pack(groups, cols) {
  if (cols < 2) {
    return groups.map((group) => group.cells);
  }

  const units = [];
  const pool = groups.filter((group) => group.cells.length < cols);

  for (const group of groups) {
    const size = group.cells.length;
    if (size < cols) continue;
    const rest = size % cols;
    const unit = group.cells.slice(0, size - rest);
    if (rest) {
      unit.push(...group.cells.slice(size - rest));
      const fillers = take(pool, bestFit(pool, cols - rest));
      fillers.forEach((filler) => unit.push(...filler.cells));
    }
    units.push(unit);
  }

  while (pool.length) {
    const row = take(pool, bestFit(pool, cols));
    units.push(row.flatMap((group) => group.cells));
  }
  return units;
}

export function infiniteFeed() {
  const list = document.getElementById('post-list');
  const cells = list ? [...list.querySelectorAll('.tile-cell')] : [];
  if (!list || !cells.length || list.dataset.feed) {
    return;
  }
  list.dataset.feed = 'true';

  const groups = [];
  for (const cell of cells) {
    const last = groups[groups.length - 1];
    if (last && last.name === cell.dataset.category) {
      last.cells.push(cell);
    } else {
      groups.push({ name: cell.dataset.category, cells: [cell] });
    }
  }

  const paged = cells.length > BATCH && 'IntersectionObserver' in window;
  let shown = paged ? BATCH : cells.length;

  const columns = () => {
    if (root.getAttribute('data-view') === 'list') return 1;
    return getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length;
  };

  const apply = (min) => {
    const order = [];
    let count = 0;
    for (const unit of pack(groups, columns())) {
      const visible = count < min;
      for (const cell of unit) {
        cell.classList.toggle('feed-hidden', !visible);
        order.push(cell);
      }
      if (visible) count += unit.length;
    }
    list.append(...order);
    shown = count;
    document.dispatchEvent(new Event('anco-feed-change'));
  };

  apply(shown);

  let timer = 0;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => apply(shown), 80);
  };
  window.addEventListener('resize', later);
  document.addEventListener('anco-view-change', () => apply(shown));

  if (!paged) {
    return;
  }

  const sentinel = document.createElement('div');
  sentinel.className = 'feed-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');
  list.after(sentinel);

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      apply(shown + BATCH);
      observer.unobserve(sentinel);
      if (shown >= cells.length) {
        sentinel.remove();
        return;
      }
      // the next batch is checked once the new tiles have been placed
      setTimeout(() => observer.observe(sentinel), 150);
    },
    { rootMargin: '400px 0px' }
  );
  observer.observe(sentinel);
}
