/**
 * Tiles / list switch above the post list on the home page (see _layouts/home.html).
 * Tiles are the main view; the choice is remembered in the browser (`anco-view`).
 */

export function viewSwitch() {
  const buttons = document.querySelectorAll('.view-switch-btn');
  if (buttons.length === 0 || document.querySelector('.view-switch')?.dataset.bound) {
    return;
  }
  document.querySelector('.view-switch').dataset.bound = 'true';

  const root = document.documentElement;
  const paint = () => {
    const view = root.getAttribute('data-view') === 'list' ? 'list' : 'tiles';
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    }
  };

  for (const button of buttons) {
    button.addEventListener('click', () => {
      if (button.dataset.view === 'list') {
        root.setAttribute('data-view', 'list');
      } else {
        root.removeAttribute('data-view');
      }

      try {
        localStorage.setItem('anco-view', button.dataset.view);
      } catch {
        // storage blocked: the choice just will not persist
      }
      paint();
      document.dispatchEvent(new Event('anco-view-change'));
    });
  }

  paint();
}
