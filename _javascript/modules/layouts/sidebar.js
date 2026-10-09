const ATTR_DISPLAY = 'sidebar-display';
const ATTR_COLLAPSED = 'sidebar-collapsed';
const COLLAPSE_STORAGE_KEY = 'sidebar-collapsed';
const $sidebar = document.getElementById('sidebar');
const $trigger = document.getElementById('sidebar-trigger');
const $mask = document.getElementById('mask');
const $collapseTrigger = document.getElementById('sidebar-collapse-trigger');

class SidebarUtil {
  static #isExpanded = false;

  static toggle() {
    this.#isExpanded = !this.#isExpanded;
    document.body.toggleAttribute(ATTR_DISPLAY, this.#isExpanded);
    $sidebar.classList.toggle('z-2', this.#isExpanded);
    $mask.classList.toggle('d-none', !this.#isExpanded);
  }
}

class SidebarCollapseUtil {
  static #isCollapsed = localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true';

  static init() {
    this.#apply();
  }

  static toggle() {
    this.#isCollapsed = !this.#isCollapsed;
    localStorage.setItem(COLLAPSE_STORAGE_KEY, String(this.#isCollapsed));
    this.#apply();
  }

  static #apply() {
    document.documentElement.toggleAttribute(ATTR_COLLAPSED, this.#isCollapsed);
    $collapseTrigger?.setAttribute('aria-expanded', String(!this.#isCollapsed));
    $collapseTrigger?.setAttribute(
      'aria-label',
      this.#isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
    );
  }
}

export function initSidebar() {
  $trigger.onclick = $mask.onclick = () => SidebarUtil.toggle();

  SidebarCollapseUtil.init();
  $collapseTrigger?.addEventListener('click', () => SidebarCollapseUtil.toggle());
}
