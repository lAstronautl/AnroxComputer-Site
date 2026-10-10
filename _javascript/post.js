import { basic, initTopbar, initSidebar } from './modules/layouts';

import {
  loadImg,
  imgPopup,
  initLocaleDatetime,
  initClipboard,
  initToc,
  loadMermaid,
  initInteractiveMaps,
  initPixelArt
} from './modules/components';
import { initObsidianCanvas } from './modules/obsidian-canvas';

loadImg();
initToc();
imgPopup();
initSidebar();
initLocaleDatetime();
initClipboard();
initTopbar();
loadMermaid();
initObsidianCanvas();
initInteractiveMaps();
initPixelArt();
basic();
