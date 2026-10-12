/**
 * A rotary volume knob in the console's style: drag around it, use the wheel, arrow keys
 * (Home / End jump to 0 / 100%), or double-click to mute and unmute. The value is 0..1.
 */

const START = -135; // degrees from "straight up" at value 0
const END = 135; // ... at value 1
const STEP = 0.05;

const percent = (value) => `${Math.round(value * 100)}%`;

export function createKnob(host, { value = 0.8, label = 'ГРОМКОСТЬ', onInput }) {
  const compact = host.classList.contains('rp-knob-mini');
  host.classList.add('rp-knob');
  host.setAttribute('role', 'slider');
  host.setAttribute('tabindex', '0');
  host.setAttribute('aria-label', 'Громкость');
  host.setAttribute('aria-valuemin', '0');
  host.setAttribute('aria-valuemax', '100');
  host.replaceChildren();

  let text = null;
  if (!compact) {
    const name = document.createElement('span');
    name.className = 'rp-knob-label';
    name.textContent = label;
    host.append(name);
  }

  const dial = document.createElement('span');
  dial.className = 'rp-knob-dial';
  const needle = document.createElement('span');
  needle.className = 'rp-knob-needle';
  dial.append(needle);
  host.append(dial);

  if (!compact) {
    text = document.createElement('span');
    text.className = 'rp-knob-value';
    host.append(text);
  }

  let current = value;
  let before = value > 0 ? value : 0.8; // what a double-click un-mutes to

  const render = (next) => {
    current = Math.min(1, Math.max(0, next));
    host.style.setProperty('--knob-angle', `${START + (END - START) * current}deg`);
    host.setAttribute('aria-valuenow', String(Math.round(current * 100)));
    host.setAttribute('title', `Громкость: ${percent(current)}`);
    if (text) text.textContent = percent(current);
  };

  const input = (next) => {
    const rounded = Math.round(Math.min(1, Math.max(0, next)) * 100) / 100;
    if (rounded === current) return;
    if (rounded > 0) before = rounded;
    render(rounded);
    onInput?.(current);
  };

  // dragging around the dial: the needle follows the pointer
  const follow = (event) => {
    const box = dial.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    const angle = Math.min(END, Math.max(START, (Math.atan2(dx, -dy) * 180) / Math.PI));
    input((angle - START) / (END - START));
  };

  let dragging = false;
  // pressing only grabs the knob; the value changes as it is turned (so a double-click can mute)
  host.addEventListener('pointerdown', (event) => {
    dragging = true;
    host.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  host.addEventListener('pointermove', (event) => {
    if (dragging) follow(event);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    host.addEventListener(type, () => {
      dragging = false;
    });
  }

  host.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      input(current + (event.deltaY < 0 ? STEP : -STEP));
    },
    { passive: false }
  );

  host.addEventListener('keydown', (event) => {
    const keys = {
      ArrowUp: current + STEP,
      ArrowRight: current + STEP,
      ArrowDown: current - STEP,
      ArrowLeft: current - STEP,
      PageUp: current + 0.1,
      PageDown: current - 0.1,
      Home: 0,
      End: 1
    };
    if (event.key in keys) {
      event.preventDefault();
      input(keys[event.key]);
    }
  });

  host.addEventListener('dblclick', () => input(current > 0 ? 0 : before));

  render(value);
  return { set: render };
}
