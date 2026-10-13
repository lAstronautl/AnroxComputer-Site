export const ESC = '\x1b';

const paint = (open, close) => (text) => `${ESC}[${open}m${text}${ESC}[${close}m`;

// Palette indices (30-37 / 90-97), so the colours follow the terminal theme in CSS.
export const c = {
  red: paint(31, 39),
  green: paint(32, 39),
  amber: paint(33, 39),
  blue: paint(34, 39),
  magenta: paint(35, 39),
  cyan: paint(36, 39),
  grey: paint(90, 39),
  bright: paint(97, 39),
  bold: paint(1, 22),
  inverse: paint(7, 27),
  strike: paint(9, 29)
};

// terminals need CR+LF
export const crlf = (text) => String(text).replace(/\r?\n/g, '\r\n');

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const visibleLength = (text) => [...String(text).replace(ANSI, '')].length;

/**
 * Console-only wording. A post writes `<span data-console="new">old</span>`; the site shows the old text,
 * the console shows it struck through with the new text next to it. The build turns the tag into ⟦old⇒new⟧.
 */
const SWAP = /⟦([^⇒⟧]*)⇒([^⟧]*)⟧/g;

export const swapText = (old, now) => `${c.strike(c.grey(old))} ${c.bright(now)}`;

export const withConsoleSwaps = (text) => String(text).replace(SWAP, (_, old, now) => swapText(old, now));

export const plainSwaps = (text) => String(text).replace(SWAP, (_, old, now) => `${old} ${now}`);
