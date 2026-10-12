import { back2top, loadTooltip, bootScreen, modeWatcher, terminalFx, infiniteFeed, tileFrames, viewSwitch } from '../components';

export function basic() {
  modeWatcher();
  bootScreen();
  viewSwitch();
  infiniteFeed();
  tileFrames();
  terminalFx();
  back2top();
  loadTooltip();
}
