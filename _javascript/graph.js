import { basic, initSidebar, initTopbar } from './modules/layouts';
import './modules/quartz/graph.inline';

initSidebar();
initTopbar();
basic();

if (!window.spaNavigate) {
  window.spaNavigate = (url) => window.location.assign(url);
}

if (!window.addCleanup) {
  window.addCleanup = () => {};
}

const SETTINGS_KEY = 'chirpy-graph-settings';

function readJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  const parsed = raw ? readJson(raw) : null;
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applySettingsToContainer(container, settings) {
  if (!container?.dataset?.cfg) return;
  const cfg = readJson(container.dataset.cfg);
  if (!cfg) return;

  const next = { ...cfg, ...settings };
  container.dataset.cfg = JSON.stringify(next);
}

function rerenderGraphs() {
  const slug = document.body?.dataset?.slug;
  if (!slug) return;
  const event = new CustomEvent('nav', { detail: { url: slug } });
  document.dispatchEvent(event);
}

function initGraphSettingsMenus() {
  const settings = loadSettings();

  document.querySelectorAll('.graph').forEach((graphSection) => {
    const graphOuter = graphSection.querySelector('.graph-outer');
    if (!graphOuter) return;

    const localContainer = graphSection.querySelector('.graph-container');
    const globalContainer = graphSection.querySelector('.global-graph-container');

    // apply persisted settings before first render
    if (localContainer) applySettingsToContainer(localContainer, settings);
    if (globalContainer) applySettingsToContainer(globalContainer, settings);

    const icon = graphOuter.querySelector('.graph-settings-icon');
    const panel = graphOuter.querySelector('.graph-settings');
    if (!icon || !panel) return;

    function syncInputsFromCfg() {
      const cfg = readJson((localContainer || globalContainer)?.dataset?.cfg || '{}') || {};
      panel.querySelectorAll('[data-graph-setting]').forEach((input) => {
        const key = input.dataset.graphSetting;
        if (!key) return;
        if (input.type === 'checkbox') {
          if (key === 'showGraphTag') {
            // Stored internally as `hideGraphTag`
            input.checked = cfg.hideGraphTag !== true;
          } else {
            input.checked = cfg[key] !== false;
          }
        } else {
          if (cfg[key] !== undefined) input.value = cfg[key];
        }
      });
    }

    function updateSetting(key, value) {
      const next = { ...loadSettings(), [key]: value };
      saveSettings(next);
      if (localContainer) applySettingsToContainer(localContainer, next);
      if (globalContainer) applySettingsToContainer(globalContainer, next);
      rerenderGraphs();
    }

    icon.addEventListener('click', (e) => {
      e.preventDefault();
      panel.hidden = !panel.hidden;
      if (!panel.hidden) syncInputsFromCfg();
    });

    document.addEventListener('click', (e) => {
      if (panel.hidden) return;
      if (graphOuter.contains(e.target)) return;
      panel.hidden = true;
    });

    panel.addEventListener('change', (e) => {
      const input = e.target;
      const key = input?.dataset?.graphSetting;
      if (!key) return;

      if (input.type === 'checkbox') {
        if (key === 'showGraphTag') {
          updateSetting('hideGraphTag', !input.checked);
        } else {
          updateSetting(key, !!input.checked);
        }
      } else {
        const num = Number(input.value);
        if (Number.isFinite(num)) updateSetting(key, num);
      }
    });
  });

  // global modal settings (optional): tie to buttons if present
  document.querySelectorAll('.graph-settings-icon--global').forEach((icon) => {
    const outer = icon.closest('.global-graph-outer');
    const panel = outer?.querySelector('.graph-settings--global');
    if (!outer || !panel) return;
    icon.addEventListener('click', (e) => {
      e.preventDefault();
      panel.hidden = !panel.hidden;
    });
  });
}

function getGraphIndexUrl() {
  const container =
    document.querySelector('.graph-container') ||
    document.querySelector('.global-graph-container');
  if (!container) return null;
  return container.dataset.indexUrl || null;
}

const indexUrl = getGraphIndexUrl();
if (indexUrl) {
  // Quartz graph script expects a global `fetchData` promise.
  window.fetchData = fetch(indexUrl, { cache: 'no-store' }).then((r) => r.json());
}

// Trigger initial render (Quartz expects SPA "nav" event)
document.addEventListener('DOMContentLoaded', () => {
  initGraphSettingsMenus();
  const slug = document.body?.dataset?.slug;
  if (!slug) return;
  const event = new CustomEvent('nav', { detail: { url: slug } });
  document.dispatchEvent(event);
});
