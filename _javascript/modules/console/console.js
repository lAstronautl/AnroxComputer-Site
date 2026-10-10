/**
 * Role-play corporate console ("Консоль" tab).
 * wterm provides the terminal emulator (WASM core + DOM renderer); this file is
 * the "operating system" on top of it: line editing, commands, accounts, files.
 * Content comes from `_data/console.yml`, accounts are kept in the browser.
 */

import { WTerm } from '@wterm/dom';
import { ESC, c, crlf, visibleLength } from './ansi';
import {
  buildFs,
  createUser,
  getSessionName,
  getUser,
  logAttempt,
  setSessionName,
  updateUser,
  verifyUser
} from './storage';
import { playHack, playSnake } from './games';

// eslint-disable-next-line no-control-regex
const TOKENS = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
const NAME_RULE = /^[\p{L}\p{N}_-]{2,24}$/u;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOGO = [
  '   ___   _  _  ___  ___ ',
  '  / _ \\ | \\| |/ __|/ _ \\',
  ' |  _  || .` | (__| (_) |',
  ' |_| |_||_|\\_|\\___|\\___/'
];

class Shell {
  constructor(data) {
    this.data = data;
    this.term = null;
    this.fs = buildFs(data.files ?? []);
    this.user = null;
    this.cwd = '/';
    this.line = '';
    this.cursor = 0;
    this.history = [];
    this.historyIndex = -1;
    this.promptText = '';
    this.askState = null;
    this.keyHandler = null;
    this.busy = true;
    this.commands = this.buildCommands();
  }

  /* ---------- output ---------- */

  raw(text) {
    this.term.write(text);
  }

  print(text = '') {
    this.term.write(crlf(text));
  }

  println(text = '') {
    this.term.write(`${crlf(text)}\r\n`);
  }

  clear() {
    this.raw(`${ESC}[2J${ESC}[3J${ESC}[H`);
  }

  levelName(level) {
    return this.data.levels?.[level] ?? `L${level}`;
  }

  /* ---------- line editor ---------- */

  promptString() {
    if (!this.user) return `${c.grey('гость@анко')} ${c.red('$')} `;
    return `${c.green(this.user.name)}${c.grey('@анко')} ${c.blue(this.cwd)}${c.red(' $')} `;
  }

  showPrompt() {
    this.promptText = this.promptString();
    this.line = '';
    this.cursor = 0;
    this.historyIndex = -1;
    this.redraw();
  }

  redraw() {
    const shown = this.askState?.secret ? '•'.repeat(this.line.length) : this.line;
    const back = [...this.line].length - this.cursor;
    this.raw(`\r${this.promptText}${shown}${ESC}[K${back > 0 ? `${ESC}[${back}D` : ''}`);
  }

  ask(question, { secret = false } = {}) {
    return new Promise((resolve) => {
      this.askState = { resolve, secret };
      this.promptText = question;
      this.line = '';
      this.cursor = 0;
      this.redraw();
    });
  }

  setKeyHandler(handler) {
    this.keyHandler = handler;
  }

  handleData(data) {
    for (const token of data.match(TOKENS) ?? []) {
      if (this.keyHandler) {
        this.keyHandler(token);
      } else if (!this.busy || this.askState) {
        this.edit(token);
      }
    }
  }

  edit(token) {
    const chars = [...this.line];
    const maxLen = Math.max(10, (this.term.cols ?? 80) - visibleLength(this.promptText) - 2);

    switch (token) {
      case '\r':
        this.submit();
        return;
      case '\x7f':
      case '\b':
        if (this.cursor > 0) {
          chars.splice(this.cursor - 1, 1);
          this.line = chars.join('');
          this.cursor -= 1;
        }
        break;
      case `${ESC}[3~`:
        chars.splice(this.cursor, 1);
        this.line = chars.join('');
        break;
      case `${ESC}[D`:
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case `${ESC}[C`:
        this.cursor = Math.min(chars.length, this.cursor + 1);
        break;
      case `${ESC}[H`:
      case '\x01':
        this.cursor = 0;
        break;
      case `${ESC}[F`:
      case '\x05':
        this.cursor = chars.length;
        break;
      case `${ESC}[A`:
      case `${ESC}[B`:
        this.browseHistory(token === `${ESC}[A` ? 1 : -1);
        break;
      case '\x15':
        this.line = '';
        this.cursor = 0;
        break;
      case '\x0c':
        this.clear();
        break;
      case '\x03':
        this.cancel();
        return;
      case '\t':
        if (!this.askState) this.complete();
        return;
      default:
        // printable text only: control characters and unknown escape sequences are dropped
        if (token.codePointAt(0) >= 32 && token !== ESC && !token.startsWith(ESC) && chars.length < maxLen) {
          chars.splice(this.cursor, 0, token);
          this.line = chars.join('');
          this.cursor += 1;
        } else {
          return;
        }
    }

    this.redraw();
  }

  browseHistory(step) {
    if (this.askState || this.history.length === 0) return;
    const next = this.historyIndex + step;
    if (next < -1 || next >= this.history.length) return;

    this.historyIndex = next;
    this.line = next === -1 ? '' : this.history[this.history.length - 1 - next];
    this.cursor = [...this.line].length;
  }

  cancel() {
    this.raw(`${c.grey('^C')}\r\n`);
    if (this.askState) {
      const { resolve } = this.askState;
      this.askState = null;
      this.line = '';
      this.cursor = 0;
      resolve(null);
      return;
    }
    this.showPrompt();
  }

  submit() {
    const text = this.line;
    this.raw('\r\n');

    if (this.askState) {
      const { resolve } = this.askState;
      this.askState = null;
      this.line = '';
      this.cursor = 0;
      resolve(text);
      return;
    }

    this.line = '';
    this.cursor = 0;
    void this.run(text);
  }

  async run(text) {
    this.busy = true;
    const trimmed = text.trim();
    if (trimmed) this.history.push(trimmed);

    try {
      await this.exec(trimmed);
    } catch (error) {
      this.println(c.red(`Сбой терминала: ${error.message}`));
    }

    this.busy = false;
    this.showPrompt();
  }

  /* ---------- tab completion ---------- */

  complete() {
    const before = [...this.line].slice(0, this.cursor).join('');
    const parts = before.split(/\s+/);
    const word = parts[parts.length - 1];
    let options;
    let prefix = '';

    if (parts.length === 1) {
      options = Object.keys(this.commands).filter((name) => name.startsWith(word.toLowerCase()));
    } else {
      const slash = word.lastIndexOf('/');
      prefix = word.slice(0, slash + 1);
      const dir = this.fs.getDir(this.fs.resolve(this.cwd, prefix || '.'));
      if (!dir) return;
      const { folders, files } = this.fs.list(dir);
      const base = word.slice(slash + 1).toLowerCase();
      options = [
        ...folders.map((name) => `${name}/`),
        ...files.map((file) => file.path.split('/').pop())
      ].filter((name) => name.toLowerCase().startsWith(base));
    }

    if (options.length === 0) return;

    if (options.length === 1) {
      const rest = [...this.line].slice(this.cursor).join('');
      const completed = parts.slice(0, -1).concat(prefix + options[0]).join(' ');
      this.line = `${completed}${options[0].endsWith('/') ? '' : ' '}${rest}`;
      this.cursor = [...completed].length + (options[0].endsWith('/') ? 0 : 1);
      this.redraw();
      return;
    }

    this.raw(`\r\n${c.grey(options.join('  '))}\r\n`);
    this.redraw();
  }

  /* ---------- session ---------- */

  signIn(user, { silent = false } = {}) {
    this.user = user;
    this.cwd = '/';
    setSessionName(user.name);
    if (silent) return;

    this.println(c.green(`Вход выполнен. Добро пожаловать, ${user.name}.`));
    this.println(`Допуск: ${c.bright(this.levelName(user.level))} (L${user.level}). Введите ${c.amber('help')}.`);
  }

  refreshUser() {
    if (this.user) this.user = getUser(this.user.name);
  }

  saveStats(patch) {
    if (!this.user) return;
    const stats = { ...(this.user.stats ?? {}), ...patch };
    this.user = updateUser(this.user.name, { stats });
  }

  log(entry) {
    if (this.user) logAttempt(this.user.name, entry);
  }

  requireLogin() {
    if (this.user) return true;
    this.println(c.red('Требуется вход в систему.') + ` Команды: ${c.amber('login')} или ${c.amber('register')}.`);
    return false;
  }

  canRead(file) {
    return (this.user?.level ?? 0) >= file.level;
  }

  findFile(arg) {
    if (!arg) return null;
    const direct = this.fs.getFile(this.fs.resolve(this.cwd, arg));
    if (direct) return direct;

    // `cat readme` — match by name without extension, anywhere
    const wanted = arg.toLowerCase().replace(/\.[^.]+$/, '');
    const hits = this.fs.files.filter((file) => {
      const base = file.path.split('/').pop().toLowerCase().replace(/\.[^.]+$/, '');
      return base === wanted;
    });
    return hits.length === 1 ? hits[0] : null;
  }

  /* ---------- commands ---------- */

  exec(text) {
    if (!text) return Promise.resolve();

    const args = [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
    const name = args.shift().toLowerCase();
    const command = this.commands[name];

    if (!command) {
      this.println(`${c.red(`команда не найдена: ${name}`)}. Введите ${c.amber('help')}.`);
      return Promise.resolve();
    }

    if (command.auth && !this.requireLogin()) return Promise.resolve();
    return command.run(args);
  }

  buildCommands() {
    const commands = {
      help: {
        desc: 'список команд',
        run: () => this.cmdHelp()
      },
      about: {
        desc: 'о системе',
        run: () => this.cmdAbout()
      },
      clear: {
        desc: 'очистить экран',
        run: () => this.clear()
      },
      register: {
        desc: 'зарегистрировать сотрудника',
        run: () => this.cmdRegister()
      },
      login: {
        desc: 'войти в систему',
        run: () => this.cmdLogin()
      },
      logout: {
        desc: 'выйти',
        auth: true,
        run: () => this.cmdLogout()
      },
      whoami: {
        desc: 'сведения о сотруднике',
        auth: true,
        run: () => this.cmdWhoami()
      },
      ls: {
        desc: 'список файлов',
        auth: true,
        run: (args) => this.cmdLs(args)
      },
      cd: {
        desc: 'сменить каталог',
        auth: true,
        run: (args) => this.cmdCd(args)
      },
      pwd: {
        desc: 'текущий каталог',
        auth: true,
        run: () => this.println(this.cwd)
      },
      tree: {
        desc: 'дерево каталогов',
        auth: true,
        run: () => this.cmdTree()
      },
      cat: {
        desc: 'прочитать файл (cat <файл>)',
        auth: true,
        run: (args) => this.cmdCat(args)
      },
      search: {
        desc: 'поиск по базе (search <слово>)',
        auth: true,
        run: (args) => this.cmdSearch(args)
      },
      auth: {
        desc: 'ввести код допуска (auth <КОД>)',
        auth: true,
        run: (args) => this.cmdAuth(args)
      },
      log: {
        desc: 'журнал ваших обращений',
        auth: true,
        run: () => this.cmdLog()
      },
      games: {
        desc: 'список игр',
        auth: true,
        run: () => this.cmdGames()
      },
      play: {
        desc: 'запустить игру (play <игра>)',
        auth: true,
        run: (args) => this.cmdPlay(args)
      }
    };

    // short aliases
    commands.dir = commands.ls;
    commands.type = commands.cat;
    commands.open = commands.cat;
    commands.find = commands.search;
    commands.cls = commands.clear;
    commands.exit = commands.logout;
    commands['?'] = commands.help;
    return commands;
  }

  cmdHelp() {
    const shown = new Set();
    this.println(c.bold(c.red('Команды:')));
    for (const [name, command] of Object.entries(this.commands)) {
      if (shown.has(command) || ['dir', 'type', 'open', 'find', 'cls', 'exit', '?'].includes(name)) continue;
      shown.add(command);
      this.println(`  ${c.amber(name.padEnd(10))} ${command.desc}${command.auth && !this.user ? c.grey('  [после входа]') : ''}`);
    }
    this.println(c.grey('Tab — дополнить, ↑/↓ — история, Ctrl+C — отмена, Ctrl+L — очистить.'));
  }

  cmdAbout() {
    this.println(`${c.red(this.data.title ?? 'КОНСОЛЬ')}`);
    this.println(c.grey(this.data.version ?? ''));
    this.println('Ролевая корпоративная сеть. Всё происходящее здесь — игра: аккаунты хранятся');
    this.println('только в вашем браузере, «секретные» файлы придуманы.');
  }

  async cmdRegister() {
    this.println(c.bold(c.red('=== РЕГИСТРАЦИЯ СОТРУДНИКА ===')) + c.grey('  (Ctrl+C — отмена)'));

    const name = (await this.ask(c.amber('Позывной (2–24 символа): ')))?.trim();
    if (name == null) return;
    if (!NAME_RULE.test(name)) {
      this.println(c.red('Позывной: 2–24 символа, только буквы, цифры, «_» и «-».'));
      return;
    }
    if (getUser(name)) {
      this.println(c.red('Сотрудник с таким позывным уже зарегистрирован.'));
      return;
    }

    const departments = this.data.departments ?? [];
    this.println(c.amber('Отдел:'));
    departments.forEach((d, i) => this.println(`  ${c.bright(String(i + 1))}. ${d.name}`));
    const pick = await this.ask(c.amber('Номер отдела: '));
    if (pick == null) return;
    const department = departments[Number(pick.trim()) - 1];
    if (!department) {
      this.println(c.red('Нет такого отдела.'));
      return;
    }

    const password = await this.ask(c.amber('Пароль (от 4 символов): '), { secret: true });
    if (password == null) return;
    if (password.length < 4) {
      this.println(c.red('Пароль слишком короткий.'));
      return;
    }
    const again = await this.ask(c.amber('Повторите пароль: '), { secret: true });
    if (again == null) return;
    if (again !== password) {
      this.println(c.red('Пароли не совпадают.'));
      return;
    }

    const user = await createUser({ name, department: department.name, password, level: department.level });
    if (!user) {
      this.println(c.red('Не удалось создать аккаунт.'));
      return;
    }

    this.println(c.green('Сотрудник внесён в реестр.'));
    this.signIn(user);
  }

  async cmdLogin() {
    if (this.user) {
      this.println(c.grey(`Вы уже вошли как ${this.user.name}. Сначала logout.`));
      return;
    }

    const name = (await this.ask(c.amber('Позывной: ')))?.trim();
    if (!name) return;
    const password = await this.ask(c.amber('Пароль: '), { secret: true });
    if (password == null) return;

    const user = await verifyUser(name, password);
    if (!user) {
      this.println(c.red('Неверный позывной или пароль.'));
      return;
    }
    this.signIn(user);
  }

  cmdLogout() {
    this.println(c.grey(`Сеанс ${this.user.name} завершён.`));
    this.user = null;
    this.cwd = '/';
    setSessionName(null);
  }

  cmdWhoami() {
    const user = this.user;
    const stats = user.stats ?? {};
    this.println(`${c.bold(c.red(user.name))}`);
    this.println(`  Отдел:   ${user.department}`);
    this.println(`  Допуск:  ${c.bright(this.levelName(user.level))} (L${user.level})`);
    this.println(`  Регистрация: ${new Date(user.registered).toLocaleString('ru-RU')}`);
    this.println(`  Рекорд «Змейки»: ${stats.snake ?? 0}   Взломов: ${stats.hacks ?? 0}`);
  }

  tag(file) {
    const ok = this.canRead(file);
    const label = `L${file.level}`;
    return ok ? c.green(`[${label}]`) : c.red(`[${label} ✗]`);
  }

  cmdLs(args) {
    const target = this.fs.getDir(this.fs.resolve(this.cwd, args[0] ?? '.'));
    if (!target) {
      this.println(c.red('Нет такого каталога.'));
      return;
    }

    const { folders, files } = this.fs.list(target);
    if (folders.length === 0 && files.length === 0) {
      this.println(c.grey('(пусто)'));
      return;
    }

    for (const folder of folders) this.println(`  ${c.blue(`${folder}/`)}`);
    for (const file of files) {
      this.println(`  ${this.tag(file).padEnd(18)} ${file.path.split('/').pop()}  ${c.grey(file.title ?? '')}`);
    }
  }

  cmdCd(args) {
    const dir = this.fs.getDir(this.fs.resolve(this.cwd, args[0] ?? '/'));
    if (!dir) {
      this.println(c.red('Нет такого каталога.'));
      return;
    }
    this.cwd = dir;
  }

  cmdTree() {
    const walk = (dir, indent) => {
      const { folders, files } = this.fs.list(dir);
      for (const folder of folders) {
        this.println(`${indent}${c.blue(`${folder}/`)}`);
        walk(dir === '/' ? `/${folder}` : `${dir}/${folder}`, `${indent}  `);
      }
      for (const file of files) {
        this.println(`${indent}${file.path.split('/').pop()} ${this.tag(file)}`);
      }
    };

    this.println(c.blue('/'));
    walk('/', '  ');
  }

  cmdCat(args) {
    if (!args[0]) {
      this.println(c.grey('Использование: cat <файл>'));
      return;
    }

    const file = this.findFile(args[0]);
    if (!file) {
      this.println(c.red(`Файл не найден: ${args[0]}`));
      return;
    }

    if (!this.canRead(file)) {
      this.println(c.red(`ДОСТУП ЗАПРЕЩЁН. Требуется допуск: ${this.levelName(file.level)} (L${file.level}).`));
      this.println(c.grey('Попытка обращения записана в журнал.'));
      this.log({ action: 'denied', target: file.path });
      return;
    }

    this.println(c.red(`── ${file.title ?? file.path} ${'─'.repeat(Math.max(2, 40 - [...(file.title ?? file.path)].length))}`));
    this.println(String(file.text ?? '').trimEnd());
    this.println(c.red('─'.repeat(44)));
    this.log({ action: 'read', target: file.path });
  }

  cmdSearch(args) {
    const query = args.join(' ').trim();
    if (!query) {
      this.println(c.grey('Использование: search <слово>'));
      return;
    }

    const needle = query.toLowerCase();
    const hits = this.fs.files.filter((file) => `${file.title ?? ''}\n${file.text ?? ''}`.toLowerCase().includes(needle));

    if (hits.length === 0) {
      this.println(c.grey('Совпадений не найдено.'));
      return;
    }

    this.println(c.bold(c.red(`Найдено: ${hits.length}`)));
    for (const file of hits) {
      if (!this.canRead(file)) {
        // classified entries show up in the index, but their contents stay hidden
        this.println(`  ${c.red(`[ЗАСЕКРЕЧЕНО L${file.level}]`)} ${file.path}  ${c.red('██████████')}`);
        continue;
      }

      const flat = String(file.text ?? '').replace(/\s+/g, ' ');
      const at = flat.toLowerCase().indexOf(needle);
      const snippet = at === -1 ? flat.slice(0, 60) : `…${flat.slice(Math.max(0, at - 24), at + needle.length + 30)}…`;
      this.println(`  ${this.tag(file)} ${c.bright(file.path)}  ${c.grey(file.title ?? '')}`);
      if (snippet) this.println(`      ${c.grey(snippet)}`);
    }
  }

  cmdAuth(args) {
    const typed = args.join(' ').trim().toUpperCase();
    if (!typed) {
      this.println(c.grey('Использование: auth <КОД>'));
      return;
    }

    const entry = (this.data.codes ?? []).find((item) => item.code.toUpperCase() === typed);
    if (!entry) {
      this.println(c.red('КОД НЕДЕЙСТВИТЕЛЕН.'));
      this.log({ action: 'bad-code', target: typed });
      return;
    }

    if (entry.level <= this.user.level) {
      this.println(c.grey('У вас уже есть этот допуск или выше.'));
      return;
    }

    const codes = [...new Set([...(this.user.codes ?? []), entry.code])];
    this.user = updateUser(this.user.name, { level: entry.level, codes });
    this.println(c.green(`ДОПУСК ПОВЫШЕН: ${this.levelName(entry.level)} (L${entry.level}).`));
    this.log({ action: 'auth', target: `L${entry.level}` });
  }

  cmdLog() {
    const attempts = this.user.attempts ?? [];
    if (attempts.length === 0) {
      this.println(c.grey('Журнал пуст.'));
      return;
    }

    for (const item of attempts.slice(-12)) {
      const when = new Date(item.t).toLocaleString('ru-RU');
      const mark = item.action === 'denied' || item.action === 'bad-code' || item.action === 'hack-failed' ? c.red : c.grey;
      this.println(`  ${c.grey(when)}  ${mark(item.action.padEnd(12))} ${item.target ?? ''}`);
    }
  }

  cmdGames() {
    this.println(c.bold(c.red('Игры для перерывов:')));
    this.println(`  ${c.amber('snake')}  — «Змейка»  ${c.grey('(стрелки / WASD)')}`);
    this.println(`  ${c.amber('hack')}   — «Взлом»   ${c.grey('(найдите пароль в дампе памяти)')}`);
    this.println(c.grey('Запуск: play snake'));
  }

  async cmdPlay(args) {
    const game = (args[0] ?? '').toLowerCase();
    if (game === 'snake' || game === 'змейка') await playSnake(this);
    else if (game === 'hack' || game === 'взлом') await playHack(this);
    else this.println(c.grey('Использование: play snake | play hack'));
  }

  /* ---------- start-up ---------- */

  async boot() {
    this.busy = true;

    for (const row of LOGO) {
      this.println(c.red(row));
      await sleep(40);
    }
    this.println('');
    this.println(c.bright(this.data.title ?? 'КОНСОЛЬ'));
    this.println(c.grey(this.data.version ?? ''));
    await sleep(120);
    this.println(c.grey('Проверка каналов связи ...... ') + c.green('OK'));
    await sleep(90);
    this.println(c.grey('Шифрование ................... ') + c.green('OK'));
    await sleep(90);

    const stored = getSessionName();
    const user = stored ? getUser(stored) : null;
    if (user) {
      this.signIn(user, { silent: true });
      this.println(c.green(`Сеанс восстановлен: ${user.name} (${this.levelName(user.level)}).`));
    } else {
      this.println('');
      this.println(`Для доступа: ${c.amber('register')} — новый сотрудник, ${c.amber('login')} — вход, ${c.amber('help')} — команды.`);
    }
    this.println('');

    this.busy = false;
    this.showPrompt();
  }
}

export async function initConsole() {
  const root = document.getElementById('rp-console');
  if (!root || root.dataset.ready === 'true') return;
  root.dataset.ready = 'true';

  const screen = root.querySelector('.rp-console-screen');
  const dataEl = document.getElementById('rp-console-data');
  let data;

  try {
    data = JSON.parse(dataEl?.textContent ?? 'null');
  } catch {
    data = null;
  }

  if (!screen || !data) {
    root.textContent = 'Консоль недоступна: не удалось загрузить данные.';
    return;
  }

  const shell = new Shell(data);
  const term = new WTerm(screen, {
    cursorBlink: true,
    onData: (input) => shell.handleData(input)
  });
  shell.term = term;

  try {
    await term.init();
  } catch (error) {
    root.textContent = `Консоль недоступна: ${error.message}`;
    return;
  }

  root.addEventListener('click', () => term.focus());
  term.focus();
  await shell.boot();
}
