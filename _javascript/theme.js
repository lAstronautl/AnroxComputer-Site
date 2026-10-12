/**
 * Theme management class
 *
 * To reduce flickering during page load, this script should be loaded synchronously.
 */
class Theme {
  static #modeKey = 'mode';
  static #modeAttr = 'data-mode';
  static #themeKey = 'anco-theme';
  static #splashKey = 'anco-splash';
  static #bootDoneKey = 'anco-boot-done';
  static #darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  static switchable = !document.documentElement.hasAttribute(this.#modeAttr);

  static get DARK() {
    return 'dark';
  }

  static get LIGHT() {
    return 'light';
  }

  static get ANCO() {
    return 'anco';
  }

  static get CONSOLE() {
    return 'console';
  }

  /** Themes the site owner fixes in `theme_mode`; the sidebar button cycles through these (all dark). */
  static get THEMES() {
    return [this.ANCO, this.CONSOLE];
  }

  static get THEME_NAMES() {
    return {
      [this.ANCO]: 'Обычная',
      [this.CONSOLE]: 'Консольная'
    };
  }

  /** The theme chosen with the sidebar button, if any. */
  static get current() {
    return this.THEMES.includes(this.#mode) ? this.#mode : this.ANCO;
  }

  /**
   * @returns {string} Theme mode identifier
   */
  static get ID() {
    return 'theme-mode';
  }

  /**
   * Gets the current visual state of the theme.
   *
   * @returns {string} The current visual state, either the mode if it exists,
   *                   or the system dark mode state ('dark' or 'light').
   */
  static get visualState() {
    if (this.#hasMode) {
      return this.#mode;
    } else {
      return this.#sysDark ? this.DARK : this.LIGHT;
    }
  }

  /**
   * Whether the currently active mode should be treated as dark (includes 'anco').
   *
   * @returns {boolean}
   */
  static get isDark() {
    return this.#hasMode ? this.#isDarkMode : this.#sysDark;
  }

  static get #mode() {
    return (
      sessionStorage.getItem(this.#modeKey) ||
      document.documentElement.getAttribute(this.#modeAttr)
    );
  }

  static get #isDarkMode() {
    return this.#mode === this.DARK || this.THEMES.includes(this.#mode);
  }

  static get #hasMode() {
    return this.#mode !== null;
  }

  static get #sysDark() {
    return this.#darkMedia.matches;
  }

  /**
   * Maps theme modes to provided values
   * @param {string} light Value for light mode
   * @param {string} dark Value for dark mode
   * @returns {Object} Mapped values
   */
  static getThemeMapper(light, dark) {
    return {
      [this.LIGHT]: light,
      [this.DARK]: dark,
      [this.ANCO]: dark,
      [this.CONSOLE]: dark
    };
  }

  /**
   * Initializes the theme based on system preferences or stored mode
   */
  static init() {
    if (!this.switchable) {
      this.#restoreTheme();
      return;
    }

    this.#darkMedia.addEventListener('change', () => {
      const lastMode = this.#mode;
      this.#clearMode();

      if (lastMode !== this.visualState) {
        this.#notify();
      }
    });

    if (!this.#hasMode) {
      return;
    }

    if (this.#isDarkMode) {
      this.#setDark();
    } else {
      this.#setLight();
    }
  }

  /**
   * Puts back the theme picked with the sidebar button on an earlier visit
   * (the layout fixes `data-mode`, this runs before the page is painted).
   */
  static #restoreTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem(this.#themeKey);
    } catch {
      // storage blocked: keep the theme from the layout
    }

    if (saved === 'console-red') {
      saved = this.CONSOLE; // the id this theme had before there was only one console theme
      try {
        localStorage.setItem(this.#themeKey, saved);
      } catch {
        // ignore
      }
    }

    if (saved && this.THEMES.includes(saved)) {
      document.documentElement.setAttribute(this.#modeAttr, saved);
    }

    this.#prepareBoot(saved);
  }

  /**
   * Decides, before the page is painted, whether the full-screen boot overlay is needed:
   * - first visit (no theme remembered yet): the theme picker (`boot-choose`)
   * - the console theme was chosen and the splash was not switched off: the boot screen (`boot-run`),
   *   once per browser session
   */
  static #prepareBoot(saved) {
    let splash;
    let done;

    try {
      localStorage.setItem('anco-probe', '1');
      localStorage.removeItem('anco-probe');
      splash = localStorage.getItem(this.#splashKey);
      done = sessionStorage.getItem(this.#bootDoneKey);
    } catch {
      return; // storage is blocked: a choice could not be remembered, so never interrupt the page
    }

    const root = document.documentElement;
    if (!saved || !this.THEMES.includes(saved)) {
      root.classList.add('boot-choose');
    } else if (saved === this.CONSOLE && splash !== 'off' && !done) {
      root.classList.add('boot-run');
    }
  }

  /**
   * Applies and remembers a site theme. `manual` marks a switch made with the sidebar button,
   * after which the boot screen no longer plays on entry.
   */
  static setTheme(theme, { manual = false } = {}) {
    document.documentElement.setAttribute(this.#modeAttr, theme);

    try {
      localStorage.setItem(this.#themeKey, theme);
      if (manual) {
        localStorage.setItem(this.#splashKey, 'off');
      } else {
        localStorage.removeItem(this.#splashKey);
      }
    } catch {
      // storage blocked: the choice just will not persist
    }

    this.#notify();
  }

  /** Marks the boot screen as shown for this browser session. */
  static markBootDone() {
    try {
      sessionStorage.setItem(this.#bootDoneKey, '1');
    } catch {
      // ignore
    }
  }

  /**
   * Switches to the next site theme (обычная ↔ консольная) and remembers it
   */
  static cycleTheme() {
    const next = this.THEMES[(this.THEMES.indexOf(this.current) + 1) % this.THEMES.length];
    this.setTheme(next, { manual: true });
    return next;
  }

  /**
   * Flips the current theme mode
   */
  static flip() {
    if (this.#hasMode) {
      this.#clearMode();
    } else {
      this.#sysDark ? this.#setLight() : this.#setDark();
    }
    this.#notify();
  }

  static #setDark() {
    document.documentElement.setAttribute(this.#modeAttr, this.DARK);
    sessionStorage.setItem(this.#modeKey, this.DARK);
  }

  static #setLight() {
    document.documentElement.setAttribute(this.#modeAttr, this.LIGHT);
    sessionStorage.setItem(this.#modeKey, this.LIGHT);
  }

  static #clearMode() {
    document.documentElement.removeAttribute(this.#modeAttr);
    sessionStorage.removeItem(this.#modeKey);
  }

  /**
   * Notifies other plugins that the theme mode has changed
   */
  static #notify() {
    window.postMessage({ id: this.ID }, '*');
  }
}

Theme.init();

export default Theme;
