import { basic, initSidebar, initTopbar } from './modules/layouts';
import { initLocaleDatetime, initPixelArt, loadImg } from './modules/components';

loadImg();
initPixelArt();
initLocaleDatetime();
initSidebar();
initTopbar();
basic();
