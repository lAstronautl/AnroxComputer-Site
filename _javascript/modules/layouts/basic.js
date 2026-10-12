import { back2top, loadTooltip, bootScreen, modeWatcher, terminalFx, viewSwitch } from '../components';

export function basic() {
  modeWatcher();
  bootScreen();
  viewSwitch();
  terminalFx();
  back2top();
  loadTooltip();
}
