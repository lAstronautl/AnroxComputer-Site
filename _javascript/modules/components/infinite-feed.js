/**
 * Infinite feed for the home page: every post is in the page, but they are shown a few categories at a time.
 * Whole categories are revealed together, so a category frame is never cut in two; the next batch appears
 * when the end of the list scrolls into view.
 */

const BATCH = 6; // minimum number of tiles revealed per step

export function infiniteFeed() {
  const list = document.getElementById('post-list');
  const cells = list ? [...list.querySelectorAll('.tile-cell')] : [];
  if (!list || cells.length <= BATCH || list.dataset.feed) {
    return;
  }
  list.dataset.feed = 'true';

  let shown = 0;
  const reveal = () => {
    let added = 0;
    while (shown < cells.length && (added < BATCH || cells[shown].dataset.category === cells[shown - 1]?.dataset.category)) {
      cells[shown].classList.remove('feed-hidden');
      shown += 1;
      added += 1;
    }
    document.dispatchEvent(new Event('anco-view-change'));
  };

  cells.forEach((cell) => cell.classList.add('feed-hidden'));

  if (!('IntersectionObserver' in window)) {
    shown = cells.length;
    cells.forEach((cell) => cell.classList.remove('feed-hidden'));
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
      reveal();
      observer.unobserve(sentinel);
      if (shown >= cells.length) {
        sentinel.remove();
        return;
      }
      // frames are laid out after the reveal; look again once the new tiles have been placed
      setTimeout(() => observer.observe(sentinel), 150);
    },
    { rootMargin: '400px 0px' }
  );
  observer.observe(sentinel);
}
