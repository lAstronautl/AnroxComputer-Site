/**
 * Add listener for theme mode toggle
 */

const $toggle = document.getElementById('mode-toggle');
const $themeSwitch = document.getElementById('theme-switch');

function labelThemeSwitch() {
  if (!$themeSwitch) {
    return;
  }

  const label = `Тема: ${Theme.THEME_NAMES[Theme.current]}`;
  $themeSwitch.setAttribute('title', label);
  $themeSwitch.setAttribute('aria-label', label);
}

export function modeWatcher() {
  // several bundles on a page can call this: bind the click only once
  if ($themeSwitch && !$themeSwitch.dataset.bound) {
    $themeSwitch.dataset.bound = 'true';
    labelThemeSwitch();
    $themeSwitch.addEventListener('click', () => {
      Theme.cycleTheme();
      labelThemeSwitch();
    });
  }

  if (!$toggle) {
    return;
  }

  $toggle.addEventListener('click', () => {
    Theme.flip();
  });
}
