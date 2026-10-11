/**
 * Theme management class
 *
 * To reduce flickering during page load, this script should be loaded synchronously.
 */
class Theme {
  static #modeKey = 'mode';
  static #modeAttr = 'data-mode';
  static #themeKey = 'anco-theme';
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

  static get CONSOLE_RED() {
    return 'console-red';
  }

  static get CONSOLE_GREEN() {
    return 'console-green';
  }

  /** Themes the site owner fixes in `theme_mode`; the sidebar button cycles through these (all dark). */
  static get THEMES() {
    return [this.ANCO, this.CONSOLE_RED, this.CONSOLE_GREEN];
  }

  static get THEME_NAMES() {
    return {
      [this.ANCO]: 'АнКо',
      [this.CONSOLE_RED]: 'Консоль — красная',
      [this.CONSOLE_GREEN]: 'Консоль — зелёная'
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
      [this.CONSOLE_RED]: dark,
      [this.CONSOLE_GREEN]: dark
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

    if (saved && this.THEMES.includes(saved)) {
      document.documentElement.setAttribute(this.#modeAttr, saved);
    }
  }

  /**
   * Switches to the next site theme (АнКо → red console → green console) and remembers it
   */
  static cycleTheme() {
    const next = this.THEMES[(this.THEMES.indexOf(this.current) + 1) % this.THEMES.length];
    document.documentElement.setAttribute(this.#modeAttr, next);

    try {
      localStorage.setItem(this.#themeKey, next);
    } catch {
      // storage blocked: the choice just will not persist
    }

    this.#notify();
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
