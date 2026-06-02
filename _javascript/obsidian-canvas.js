import { basic, initSidebar, initTopbar } from './modules/layouts';
import { initObsidianCanvas } from './modules/obsidian-canvas';

initSidebar();
initTopbar();
basic();

document.addEventListener('DOMContentLoaded', initObsidianCanvas);
