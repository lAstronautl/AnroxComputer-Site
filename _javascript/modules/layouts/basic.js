import { back2top, loadTooltip, bootScreen, modeWatcher, terminalFx } from '../components';

export function basic() {
  modeWatcher();
  bootScreen();
  terminalFx();
  back2top();
  loadTooltip();
}
