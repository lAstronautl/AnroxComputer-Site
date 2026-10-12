/**
 * Draws the category frames around the post tiles on the home page.
 * The tiles of one category are neighbours in a single grid, so a group can be an L-shape or any other
 * block of cells. A cell gets an `edge-*` class on every side that faces another category (or the outside),
 * which together draw the outline of the group; `corner-*` rounds the outer corners and `inner-*` draws the
 * inner (concave) corners of L-shapes. The category name is
 * put on the bottom edge of the lowest-left cell of its group.
 */

export function tileFrames() {
  const list = document.getElementById('post-list');
  if (!list || !list.querySelector('.tile-cell') || list.dataset.framed) {
    return;
  }
  list.dataset.framed = 'true';

  const root = document.documentElement;
  const SIDES = [
    ['t', -1, 0],
    ['b', 1, 0],
    ['l', 0, -1],
    ['r', 0, 1]
  ];

  const layout = () => {
    const cells = [...list.querySelectorAll('.tile-cell:not(.feed-hidden)')];
    for (const cell of list.querySelectorAll('.tile-cell')) {
      cell.className = cell.classList.contains('feed-hidden') ? 'tile-cell feed-hidden' : 'tile-cell';
      cell.querySelector('.tile-group-label')?.remove();
    }
    if (root.getAttribute('data-view') === 'list') {
      return;
    }

    // grid position of every cell, from where the browser actually put it
    const place = cells.map((cell) => {
      const box = cell.getBoundingClientRect();
      return { cell, top: Math.round(box.top + window.scrollY), left: Math.round(box.left + window.scrollX) };
    });
    const rows = [...new Set(place.map((item) => item.top))].sort((a, b) => a - b);
    const cols = [...new Set(place.map((item) => item.left))].sort((a, b) => a - b);
    const grid = new Map();
    for (const item of place) {
      item.row = rows.indexOf(item.top);
      item.col = cols.indexOf(item.left);
      grid.set(`${item.row},${item.col}`, item);
    }

    const sameGroup = (item, row, col) => grid.get(`${row},${col}`)?.cell.dataset.category === item.cell.dataset.category;

    for (const item of place) {
      const open = new Set();
      for (const [side, dRow, dCol] of SIDES) {
        if (!sameGroup(item, item.row + dRow, item.col + dCol)) open.add(side);
      }
      for (const side of open) item.cell.classList.add(`edge-${side}`);
      for (const [a, b] of [
        ['t', 'l'],
        ['t', 'r'],
        ['b', 'l'],
        ['b', 'r']
      ]) {
        if (open.has(a) && open.has(b)) {
          item.cell.classList.add(`corner-${a}${b}`);
        } else if (!open.has(a) && !open.has(b)) {
          // concave corner: both neighbours belong to the group, the diagonal one does not
          const dRow = a === 't' ? -1 : 1;
          const dCol = b === 'l' ? -1 : 1;
          if (!sameGroup(item, item.row + dRow, item.col + dCol)) item.cell.classList.add(`inner-${a}${b}`);
        }
      }
    }

    // one label per category: on the bottom edge of the lowest row of the group, at its left end
    const labelled = new Set();
    const lowest = [...place].filter((item) => item.cell.classList.contains('edge-b')).sort((a, b) => b.row - a.row || a.col - b.col);
    for (const item of lowest) {
      const name = item.cell.dataset.category;
      if (!name || labelled.has(name)) continue;
      labelled.add(name);

      const label = document.createElement('span');
      label.className = 'tile-group-label';
      label.textContent = name;
      item.cell.append(label);
    }
  };

  let timer = 0;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(layout, 60);
  };

  layout();
  window.addEventListener('resize', later);
  window.addEventListener('load', layout);
  document.addEventListener('anco-view-change', layout);
  new ResizeObserver(later).observe(list);
}
