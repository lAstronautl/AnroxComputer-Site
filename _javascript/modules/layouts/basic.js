import { back2top, loadTooltip, bootScreen, modeWatcher, terminalFx, tileFrames, viewSwitch } from '../components';

export function basic() {
  modeWatcher();
  bootScreen();
  viewSwitch();
  tileFrames();
  terminalFx();
  back2top();
  loadTooltip();
}
