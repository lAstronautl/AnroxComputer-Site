import { back2top, loadTooltip, modeWatcher, terminalFx } from '../components';

export function basic() {
  modeWatcher();
  terminalFx();
  back2top();
  loadTooltip();
}
