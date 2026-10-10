import { initConsole } from './modules/console/console';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initConsole);
} else {
  initConsole();
}
