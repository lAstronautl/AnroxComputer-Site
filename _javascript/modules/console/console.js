/**
 * Role-play corporate console ("Консоль" tab).
 * wterm provides the terminal emulator (WASM core + DOM renderer); this file is
 * the "operating system" on top of it: line editing, commands, accounts, files.
 * Content comes from `_data/console.yml`, accounts are kept in the browser.
 */

import { WTerm } from '@wterm/dom';
import { ESC, c, crlf, visibleLength } from './ansi';
import { buildFs } from './storage';
import { createBackend } from './backend';
import { playHack, playSnake } from './games';
import { ConsoleSound } from './sound';

// eslint-disable-next-line no-control-regex
const TOKENS = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;
const NAME_RULE = /^[\p{L}\p{N}_-]{2,24}$/u;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// typewriter: one character every CHAR_MS; escape sequences cost nothing and are never split
const CHAR_MS = 10;
const PUMP_MS = 16;
const FAST_AFTER = 700; // long dumps speed up so a big file never takes more than a few seconds
const UNITS = /\x1b\[[0-9;?]*[A-Za-z~]|\x1b[\s\S]|[\s\S]/gu; // eslint-disable-line no-control-regex

const LOGO = [
  ' █████╗ ███╗   ██╗██████╗  ██████╗ ██╗  ██╗     ██████╗ ███████╗',
  '██╔══██╗████╗  ██║██╔══██╗██╔═══██╗╚██╗██╔╝    ██╔═══██╗██╔════╝',
  '███████║██╔██╗ ██║██████╔╝██║   ██║ ╚███╔╝     ██║   ██║███████╗',
  '██╔══██║██║╚██╗██║██╔══██╗██║   ██║ ██╔██╗     ██║   ██║╚════██║',
  '██║  ██║██║ ╚████║██║  ██║╚██████╔╝██╔╝ ██╗    ╚██████╔╝███████║',
  '╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝     ╚═════╝ ╚══════╝'
];

// the banner is 66 columns wide; narrower terminals (phones) get a plain title
const LOGO_WIDTH = 66;
const LOGO_SMALL = ['ANROX OS'];

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
    this.backend = createBackend(data);
    this.chain = Promise.resolve(); // account calls run one after another, so a refresh never overtakes a write
    this.sound = null;
    this.articlesUrl = '';
    this.articles = null;
    this.queue = [];
    this.pumpTimer = 0;
    this.pumpedAt = 0;
    this.commands = this.buildCommands();
  }

  /* ---------- output ---------- */

  get typing() {
    return this.queue.length > 0;
  }

  /** Raw terminal output. Keeps its place behind any text that is still being typed. */
  raw(text) {
    if (this.typing) this.queue.push({ text, typed: false });
    else this.term.write(text);
  }

  /** Text that appears character by character. */
  type(text) {
    const units = text.match(UNITS) ?? [];
    this.queue.push({ units, at: 0, typed: true });
    this.startPump();
  }

  print(text = '') {
    this.type(crlf(text));
  }

  println(text = '') {
    this.type(`${crlf(text)}\r\n`);
  }

  /** Instant line (used for the big banner, which would take forever to type). */
  printlnFast(text = '') {
    this.raw(`${crlf(text)}\r\n`);
  }

  startPump() {
    if (this.pumpTimer) return;
    this.pumpedAt = performance.now();
    this.pumpTimer = setInterval(() => this.pump(), PUMP_MS);
  }

  pending() {
    return this.queue.reduce((sum, item) => sum + (item.typed ? item.units.length - item.at : 0), 0);
  }

  pump() {
    const now = performance.now();
    const speed = this.pending() > FAST_AFTER ? Math.ceil(this.pending() / FAST_AFTER) : 1;
    let budget = Math.max(1, Math.floor(((now - this.pumpedAt) / CHAR_MS) * speed));
    this.pumpedAt = now;
    let out = '';
    let visible = 0;

    while (this.queue.length > 0 && budget > 0) {
      const item = this.queue[0];
      if (!item.typed) {
        out += item.text;
        this.queue.shift();
        continue;
      }

      while (item.at < item.units.length && budget > 0) {
        const unit = item.units[item.at];
        item.at += 1;
        out += unit;
        if (unit.length === 1 && unit >= ' ') {
          budget -= 1;
          if (unit !== ' ') visible += 1;
        }
      }
      if (item.at >= item.units.length) this.queue.shift();
    }

    if (out) this.term.write(out);
    if (visible) this.sound?.tick();
    if (this.queue.length === 0) this.stopPump();
  }

  stopPump() {
    clearInterval(this.pumpTimer);
    this.pumpTimer = 0;
  }

  /** Write everything still queued at once (a key press skips the typing effect). */
  skipTyping() {
    let out = '';
    for (const item of this.queue) out += item.typed ? item.units.slice(item.at).join('') : item.text;
    this.queue = [];
    this.stopPump();
    if (out) this.term.write(out);
  }

  clear() {
    this.raw(`${ESC}[2J${ESC}[3J${ESC}[H`);
  }

  get adminLevel() {
    return this.data.admin_level ?? 10;
  }

  isAdmin() {
    return (this.user?.level ?? 0) >= this.adminLevel;
  }

  levelName(level) {
    return this.data.levels?.[level] ?? `УРОВЕНЬ ${level}`;
  }

  /* ---------- line editor ---------- */

  promptString() {
    if (!this.user) return `${c.grey('guest@anrox')} ${c.red('$')} `;
    return `${c.green(this.user.name)}${c.grey('@anrox')} ${c.blue(this.cwd)}${c.red(' $')} `;
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
    if (this.typing) this.skipTyping(); // a key press skips the effect and still counts as input

    for (const token of data.match(TOKENS) ?? []) {
      if (this.keyHandler) {
        this.keyHandler(token);
      } else if (!this.busy || this.askState) {
        this.edit(token);
      }
    }
  }

  edit(token) {
    if (token === '\r' || token === '\x7f' || token === '\b' || (token.codePointAt(0) >= 32 && !token.startsWith(ESC))) {
      this.sound?.key();
    }

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
      options = Object.keys(this.commands).filter((name) => !this.commands[name].hidden && !(this.commands[name].admin && !this.isAdmin()) && name.startsWith(word.toLowerCase()));
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
    if (silent) return;

    this.println(c.green(`Вход выполнен. Добро пожаловать, ${user.name}.`));
    this.println(`Допуск: ${c.bright(this.levelName(user.level))} (L${user.level}). Введите ${c.amber('help')}.`);
  }

  /** Queue an account call; the result (a user) replaces the in-memory copy. */
  sync(task) {
    this.chain = this.chain.then(async () => {
      const user = await task(this.user);
      if (user && this.user) this.user = user;
    }).catch(() => {});
    return this.chain;
  }

  refreshUser() {
    if (!this.user) return Promise.resolve();
    return this.sync((user) => this.backend.refresh(user));
  }

  saveStats(patch) {
    if (!this.user) return Promise.resolve();
    return this.sync((user) => this.backend.saveStats(user, patch));
  }

  log(entry) {
    if (!this.user) return Promise.resolve();
    return this.sync((user) => this.backend.log(user, entry));
  }

  failure(error) {
    const text = {
      network: 'Сервер недоступен. Попробуйте позже.',
      rate: 'Слишком много попыток. Подождите минуту.',
      taken: 'Сотрудник с таким позывным уже зарегистрирован.',
      credentials: 'Неверный позывной или пароль.',
      'bad-name': 'Позывной: 2–24 символа, только буквы, цифры, «_» и «-».',
      'bad-password': 'Пароль: от 4 до 100 символов.',
      forbidden: 'ДОСТУП ЗАПРЕЩЁН. Недостаточный уровень допуска.',
      'too-high': 'Нельзя выдать уровень выше собственного.',
      'bad-level': 'Уровень — целое число от 0.',
      'bad-department': 'Нет такого отдела.',
      'not-found': 'Сотрудник не найден.',
      'not-higher': 'Это не повышение: у сотрудника уже такой или более высокий уровень.',
      self: 'Над собой эта команда не действует.',
      above: 'Нельзя управлять сотрудником равного или более высокого уровня.',
      'bad-keyword': 'Некорректное ключевое слово.',
      'not-lower': 'Это не понижение: у сотрудника уже такой или более низкий уровень.'
    }[error] ?? 'Сбой сервера. Попробуйте позже.';
    this.println(c.red(text));
  }

  requireLogin() {
    if (this.user) return true;
    this.println(c.red('Требуется вход в систему.') + ` Команды: ${c.amber('login')} или ${c.amber('register')}.`);
    return false;
  }

  hasKeyword(file) {
    if (!file.keyword || this.isAdmin()) return true;
    return (this.user?.codes ?? []).includes(file.keyword.toUpperCase());
  }

  canRead(file) {
    return (this.user?.level ?? 0) >= file.level && this.hasKeyword(file);
  }

  /** Keywords the current employee has not entered yet (hints for the hacking game). */
  closedKeywords() {
    const known = this.user?.codes ?? [];
    return [...new Set(this.fs.files.map((file) => file.keyword?.toUpperCase()).filter(Boolean))].filter((word) => !known.includes(word));
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

    if (command.admin && !this.isAdmin()) {
      this.println(c.red(`ДОСТУП ЗАПРЕЩЁН. Требуется допуск: ${this.levelName(this.adminLevel)} (L${this.adminLevel}).`));
      return Promise.resolve();
    }
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
        desc: 'ввести ключевое слово (auth <СЛОВО>)',
        auth: true,
        run: (args) => this.cmdAuth(args)
      },
      adduser: {
        desc: 'добавить сотрудника (adduser [позывной])',
        auth: true,
        admin: true,
        run: (args) => this.cmdAddUser(args)
      },
      staff: {
        desc: 'весь персонал: отдел и уровень',
        auth: true,
        run: () => this.cmdStaff()
      },
      demote: {
        desc: 'понизить сотрудника (demote <позывной> [уровень])',
        auth: true,
        admin: true,
        run: (args) => this.cmdDemote(args)
      },
      transfer: {
        desc: 'перевести в другой отдел (transfer <позывной>)',
        auth: true,
        admin: true,
        run: (args) => this.cmdTransfer(args)
      },
      resetpass: {
        desc: 'сменить пароль сотруднику (resetpass <позывной>)',
        auth: true,
        admin: true,
        run: (args) => this.cmdResetPass(args)
      },
      fire: {
        desc: 'уволить сотрудника (fire <позывной>)',
        auth: true,
        admin: true,
        run: (args) => this.cmdFire(args)
      },
      promote: {
        desc: 'повысить сотрудника (promote <позывной> [уровень])',
        auth: true,
        admin: true,
        run: (args) => this.cmdPromote(args)
      },
      log: {
        desc: 'журнал ваших обращений',
        auth: true,
        run: () => this.cmdLog()
      },
      articles: {
        desc: 'статьи архива АнКо',
        auth: true,
        run: () => this.cmdArticles()
      },
      read: {
        desc: 'прочитать статью (read <номер|слово>)',
        auth: true,
        run: (args) => this.cmdRead(args)
      },
      explosionegg: {
        hidden: true, // secret: not in help, not in tab completion
        run: () => this.cmdExplosionEgg()
      },
      flashbang: {
        desc: 'светошумовая граната',
        run: () => this.cmdFlashbang()
      },
      sound: {
        desc: 'звук консоли (sound on | off)',
        run: (args) => this.cmdSound(args)
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
    commands.useradd = commands.adduser;
    commands.unlock = commands.auth;
    commands.ключ = commands.auth;
    commands.промоушен = commands.promote;
    commands.персонал = commands.staff;
    commands.понизить = commands.demote;
    commands.перевод = commands.transfer;
    commands.уволить = commands.fire;
    commands.флешбенг = commands.flashbang;
    commands.posts = commands.articles;
    commands.статьи = commands.articles;
    commands.exit = commands.logout;
    commands['?'] = commands.help;
    return commands;
  }

  cmdHelp() {
    const shown = new Set();
    this.println(c.bold(c.red('Команды:')));
    for (const [name, command] of Object.entries(this.commands)) {
      if (shown.has(command) || command.hidden || (command.admin && !this.isAdmin()) || ['dir', 'type', 'open', 'find', 'cls', 'exit', '?'].includes(name)) continue;
      shown.add(command);
      this.println(`  ${c.amber(name.padEnd(10))} ${command.desc}${command.auth && !this.user ? c.grey('  [после входа]') : ''}`);
    }
    this.println(c.grey('Tab — дополнить, ↑/↓ — история, Ctrl+C — отмена, Ctrl+L — очистить.'));
  }

  cmdAbout() {
    this.println(`${c.red(this.data.title ?? 'КОНСОЛЬ')}`);
    this.println(c.grey(this.data.version ?? ''));
    if (this.data.subtitle) this.println(c.grey(this.data.subtitle));
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

    const result = await this.backend.register({ name, department, password });
    if (result.error) {
      this.failure(result.error);
      return;
    }

    this.println(c.green('Сотрудник внесён в реестр.'));
    this.signIn(result.user);
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

    const result = await this.backend.login(name, password);
    if (result.error) {
      this.failure(result.error);
      return;
    }
    this.signIn(result.user);
  }

  async cmdLogout() {
    this.println(c.grey(`Сеанс ${this.user.name} завершён.`));
    await this.chain;
    await this.backend.logout();
    this.user = null;
    this.cwd = '/';
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
    const label = file.keyword ? `L${file.level}+ключ` : `L${file.level}`;
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
      if ((this.user?.level ?? 0) < file.level) {
        this.println(c.red(`ДОСТУП ЗАПРЕЩЁН. Требуется допуск: ${this.levelName(file.level)} (L${file.level}).`));
      } else {
        this.println(c.red('ДОСТУП ЗАПРЕЩЁН. Файл защищён ключевым словом.') + c.grey(' Введите: auth <СЛОВО>'));
      }
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
        this.println(`  ${c.red(`[ЗАСЕКРЕЧЕНО L${file.level}${file.keyword ? '+ключ' : ''}]`)} ${file.path}  ${c.red('██████████')}`);
        continue;
      }

      const flat = String(file.text ?? '').replace(/\s+/g, ' ');
      const at = flat.toLowerCase().indexOf(needle);
      const snippet = at === -1 ? flat.slice(0, 60) : `…${flat.slice(Math.max(0, at - 24), at + needle.length + 30)}…`;
      this.println(`  ${this.tag(file)} ${c.bright(file.path)}  ${c.grey(file.title ?? '')}`);
      if (snippet) this.println(`      ${c.grey(snippet)}`);
    }
  }

  async cmdAuth(args) {
    const typed = args.join(' ').trim().toUpperCase();
    if (!typed) {
      this.println(c.grey('Использование: auth <СЛОВО>'));
      return;
    }

    const opens = this.fs.files.filter((file) => file.keyword?.toUpperCase() === typed);
    if (opens.length === 0) {
      this.println(c.red('КЛЮЧЕВОЕ СЛОВО НЕДЕЙСТВИТЕЛЬНО.'));
      await this.log({ action: 'bad-code', target: typed });
      return;
    }

    await this.chain;
    const result = await this.backend.unlock(this.user, typed);
    if (result.error === 'already') {
      this.println(c.grey('Это слово уже введено.'));
      return;
    }
    if (result.error) {
      this.failure(result.error);
      return;
    }

    this.user = result.user;
    this.println(c.green('КЛЮЧЕВОЕ СЛОВО ПРИНЯТО. ОТКРЫТЫ ФАЙЛЫ:'));
    for (const file of opens) {
      const need = (this.user.level ?? 0) < file.level ? c.grey(`  (нужен допуск L${file.level})`) : '';
      this.println(`  ${c.bright(file.path)}${need}`);
    }
    await this.refreshUser();
  }

  /** Level typed by the player: a whole number, or null when it is not one. */
  parseLevel(text) {
    const value = String(text ?? '').trim();
    return /^\d{1,3}$/.test(value) ? Number(value) : null;
  }

  async cmdAddUser(args) {
    this.println(c.bold(c.red('=== ДОБАВЛЕНИЕ СОТРУДНИКА ===')) + c.grey('  (Ctrl+C — отмена)'));

    const name = (args[0] ?? (await this.ask(c.amber('Позывной: '))))?.trim();
    if (!name) return;
    if (!NAME_RULE.test(name)) {
      this.failure('bad-name');
      return;
    }

    const departments = this.data.departments ?? [];
    this.println(c.amber('Отдел:'));
    departments.forEach((d, i) => this.println(`  ${c.bright(String(i + 1))}. ${d.name}`));
    const pick = await this.ask(c.amber('Номер отдела: '));
    if (pick == null) return;
    const department = departments[Number(pick.trim()) - 1];
    if (!department) {
      this.failure('bad-department');
      return;
    }

    const maxLevel = this.user.level;
    const levelText = await this.ask(c.amber(`Уровень допуска (0–${maxLevel}, Enter — ${department.level}): `));
    if (levelText == null) return;
    const level = levelText.trim() ? this.parseLevel(levelText) : department.level;
    if (level == null) {
      this.failure('bad-level');
      return;
    }
    if (level > maxLevel) {
      this.failure('too-high');
      return;
    }

    const password = await this.ask(c.amber('Пароль сотрудника (от 4 символов): '), { secret: true });
    if (password == null) return;
    if (password.length < 4) {
      this.failure('bad-password');
      return;
    }

    const result = await this.backend.addUser(this.user, { name, department, level, password });
    if (result.error) {
      this.failure(result.error);
      return;
    }

    this.println(c.green(`Сотрудник ${result.created.name} внесён в реестр: ${result.created.department}, `) +
      c.bright(`${this.levelName(result.created.level)} (L${result.created.level})`) + c.green('.'));
    this.println(c.grey('Передайте ему позывной и пароль.'));
    await this.refreshUser();
  }

  async cmdPromote(args) {
    const name = args[0];
    if (!name) {
      this.println(c.grey('Использование: promote <позывной> [уровень]  — без уровня повышает на 1'));
      return;
    }

    let level = null;
    if (args[1] !== undefined) {
      level = this.parseLevel(args[1]);
      if (level == null) {
        this.failure('bad-level');
        return;
      }
    }

    await this.chain;
    const result = await this.backend.promote(this.user, name, level);
    if (result.error) {
      this.failure(result.error);
    } else {
      this.println(c.green(`Сотрудник ${result.target.name} повышен: `) +
        c.bright(`${this.levelName(result.target.level)} (L${result.target.level})`) + c.green('.'));
    }

    await this.refreshUser();
  }

  /** "ОСН — отряд специального назначения" → "ОСН" */
  shortDepartment(name) {
    return String(name ?? '').split(' — ')[0];
  }

  async cmdStaff() {
    await this.chain;
    const result = await this.backend.staff();
    if (result.error) {
      this.failure(result.error);
      return;
    }

    const list = result.staff;
    this.println(c.bold(c.red(`Персонал АнКо — ${list.length}`)));
    this.println(c.grey(`  ${'№'.padStart(2)}  ${'Позывной'.padEnd(18)} ${'Отдел'.padEnd(20)} Уровень`));

    list.forEach((person, i) => {
      const me = this.user && person.name.toLowerCase() === this.user.name.toLowerCase();
      const name = (me ? `${person.name} *` : person.name).padEnd(18);
      const department = this.shortDepartment(person.department).slice(0, 20).padEnd(20);
      const level = `${this.levelName(person.level)} (L${person.level})`;
      this.println(`  ${c.grey(String(i + 1).padStart(2))}  ${me ? c.green(name) : c.bright(name)} ${department} ${c.amber(level)}`);
    });
    this.println(c.grey('* — это вы.'));
  }

  async cmdDemote(args) {
    const name = args[0];
    if (!name) {
      this.println(c.grey('Использование: demote <позывной> [уровень]  — без уровня понижает на 1'));
      return;
    }

    let level = null;
    if (args[1] !== undefined) {
      level = this.parseLevel(args[1]);
      if (level == null) {
        this.failure('bad-level');
        return;
      }
    }

    await this.chain;
    const result = await this.backend.demote(this.user, name, level);
    if (result.error) {
      this.failure(result.error);
      return;
    }
    this.println(c.green(`Сотрудник ${result.target.name} понижен: `) +
      c.bright(`${this.levelName(result.target.level)} (L${result.target.level})`) + c.green('.'));
    await this.refreshUser();
  }

  async cmdTransfer(args) {
    const name = args[0];
    if (!name) {
      this.println(c.grey('Использование: transfer <позывной>'));
      return;
    }

    const departments = this.data.departments ?? [];
    this.println(c.amber('Новый отдел:'));
    departments.forEach((d, i) => this.println(`  ${c.bright(String(i + 1))}. ${d.name}`));
    const pick = await this.ask(c.amber('Номер отдела: '));
    if (pick == null) return;
    const department = departments[Number(pick.trim()) - 1];
    if (!department) {
      this.failure('bad-department');
      return;
    }

    await this.chain;
    const result = await this.backend.transfer(this.user, name, department);
    if (result.error) {
      this.failure(result.error);
      return;
    }
    this.println(c.green(`Сотрудник ${result.target.name} переведён: ${result.target.department}.`));
    await this.refreshUser();
  }

  async cmdResetPass(args) {
    const name = args[0];
    if (!name) {
      this.println(c.grey('Использование: resetpass <позывной>'));
      return;
    }

    const password = await this.ask(c.amber(`Новый пароль для ${name} (от 4 символов): `), { secret: true });
    if (password == null) return;
    if (password.length < 4) {
      this.failure('bad-password');
      return;
    }

    await this.chain;
    const result = await this.backend.resetPassword(this.user, name, password);
    if (result.error) {
      this.failure(result.error);
      return;
    }
    this.println(c.green(`Пароль сотрудника ${result.target.name} изменён. Все его сеансы завершены.`));
    await this.refreshUser();
  }

  async cmdFire(args) {
    const name = args[0];
    if (!name) {
      this.println(c.grey('Использование: fire <позывной>'));
      return;
    }

    const answer = await this.ask(c.red(`Уволить ${name}? Аккаунт будет удалён. Введите ДА для подтверждения: `));
    if (answer == null || !['да', 'yes', 'y'].includes(answer.trim().toLowerCase())) {
      this.println(c.grey('Отменено.'));
      return;
    }

    await this.chain;
    const result = await this.backend.fire(this.user, name);
    if (result.error) {
      this.failure(result.error);
      return;
    }
    this.println(c.bold(c.red(`СОТРУДНИК ${result.target.name} УВОЛЕН. ДОСТУП АННУЛИРОВАН.`)));
    await this.refreshUser();
  }

  async cmdLog() {
    await this.refreshUser();
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

  /* ---------- site articles ---------- */

  async loadArticles() {
    if (this.articles) return this.articles;
    if (!this.articlesUrl) return null;

    try {
      const response = await fetch(this.articlesUrl);
      if (!response.ok) throw new Error(String(response.status));
      this.articles = await response.json();
    } catch {
      this.println(c.red('Архив недоступен: не удалось загрузить статьи.'));
      return null;
    }
    return this.articles;
  }

  async pickArticle(args, usage) {
    const query = args.join(' ').trim();
    if (!query) {
      this.println(c.grey(`Использование: ${usage}  (список — articles)`));
      return null;
    }

    const list = await this.loadArticles();
    if (!list) return null;

    if (/^\d+$/.test(query)) {
      const byNumber = list[Number(query) - 1];
      if (!byNumber) this.println(c.red('Нет статьи с таким номером.'));
      return byNumber ?? null;
    }

    const needle = query.toLowerCase();
    const hits = list.filter((article) => article.title.toLowerCase().includes(needle));
    if (hits.length === 1) return hits[0];

    this.println(hits.length === 0 ? c.red('Статья не найдена.') : c.red('Подходит несколько статей, уточните:'));
    for (const hit of hits) this.println(`  ${c.bright(String(list.indexOf(hit) + 1))}. ${hit.title}`);
    return null;
  }

  async cmdArticles() {
    const list = await this.loadArticles();
    if (!list) return;

    this.println(c.bold(c.red(`Архив АнКо — статей: ${list.length}`)));
    list.forEach((article, i) => {
      const where = article.categories ? c.grey(`  [${article.categories}]`) : '';
      this.println(`  ${c.bright(String(i + 1).padStart(2))}. ${article.title}${where}`);
    });
    this.println(c.grey('read <номер|слово> — прочитать статью.'));
  }

  /** Word wrap to the terminal width, so words are not cut in the middle. */
  wrap(text) {
    const width = Math.max(20, (this.term.cols ?? 80) - 2);
    return text
      .split('\n')
      .map((paragraph) => {
        const lines = [];
        let line = '';
        for (const word of paragraph.split(' ')) {
          if (line && [...line].length + 1 + [...word].length > width) {
            lines.push(line);
            line = word;
          } else {
            line = line ? `${line} ${word}` : word;
          }
        }
        lines.push(line);
        return lines.join('\n');
      })
      .join('\n');
  }

  async cmdRead(args) {
    const article = await this.pickArticle(args, 'read <номер|слово>');
    if (!article) return;

    const decoder = document.createElement('textarea');
    const body = article.text
      .split('¶')
      .map((line) => {
        decoder.innerHTML = line;
        return decoder.value.replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean)
      .join('\n\n');

    this.println(c.red(`── ${article.title} ${'─'.repeat(Math.max(2, 40 - [...article.title].length))}`));
    if (article.categories) this.println(c.grey(`Раздел: ${article.categories}`));
    this.println('');
    this.println(body ? this.wrap(body) : c.grey('(текст статьи — только на сайте: интерактивная карта, схема или изображение)'));
    this.println(c.red('─'.repeat(44)));
    this.log({ action: 'article', target: article.title });
  }

  async cmdExplosionEgg() {
    if (!this.user) {
      this.println(c.red('ДОСТУП ЗАПРЕЩЁН.'));
      return;
    }

    const name = this.user.name;
    this.println(c.red('ПРОТОКОЛ «ВЗРЫВНОЕ ЯЙЦО» АКТИВИРОВАН.'));
    await this.flush();
    for (const line of ['Отзыв допуска', 'Изъятие личных вещей', 'Удаление из реестра']) {
      await sleep(500);
      this.println(c.grey(`${line} `.padEnd(30, '.') + ' ') + c.green('OK'));
      await this.flush();
    }

    await sleep(500);
    await this.chain;
    await this.backend.remove(this.user);
    this.user = null;
    this.cwd = '/';
    this.println(c.bold(c.red(`СОТРУДНИК ${name} СНЯТ С ДОЛЖНОСТИ. ДОСТУП АННУЛИРОВАН.`)));
    this.println(c.grey('Аккаунт удалён. Для нового доступа: register.'));
  }

  cmdFlashbang() {
    this.println(c.red('ВНИМАНИЕ: светошумовая граната!'));
    this.println(c.grey('Звук громкий, экран ярко вспыхнет. Закройте глаза.'));

    const flash = document.createElement('div');
    flash.className = 'rp-flash';
    document.body.append(flash);
    this.sound?.flashbang();

    // the screen stays white for a moment, then slowly recovers
    setTimeout(() => flash.classList.add('rp-flash-fade'), 1200);
    setTimeout(() => flash.remove(), 6500);
  }

  cmdSound(args) {
    const mode = (args[0] ?? '').toLowerCase();
    if (!this.sound?.supported) {
      this.println(c.grey('Звук недоступен в этом браузере.'));
      return;
    }

    if (mode === 'on' || mode === 'вкл') this.sound.setEnabled(true);
    else if (mode === 'off' || mode === 'выкл') this.sound.setEnabled(false);
    else {
      this.println(c.grey(`Звук: ${this.sound.enabled ? 'включён' : 'выключен'}. Использование: sound on | sound off`));
      return;
    }
    this.println(c.grey(`Звук ${this.sound.enabled ? 'включён' : 'выключен'}.`));
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

  /** Resolves once the typewriter has caught up. */
  flush() {
    return new Promise((resolve) => {
      const check = () => (this.typing ? setTimeout(check, PUMP_MS) : resolve());
      check();
    });
  }

  /* ---------- start-up ---------- */

  async boot() {
    this.busy = true;

    const logo = (this.term.cols ?? 80) >= LOGO_WIDTH + 2 ? LOGO : LOGO_SMALL;
    for (const row of logo) {
      this.printlnFast(c.red(row));
      await sleep(40);
    }
    this.println('');
    this.println(c.bright(this.data.title ?? 'КОНСОЛЬ'));
    this.println(c.grey(this.data.version ?? ''));
    if (this.data.subtitle) this.println(c.grey(this.data.subtitle));
    await this.flush();
    const checks = this.data.boot_checks ?? ['Проверка каналов связи', 'Шифрование'];
    for (const check of checks) {
      this.println(c.grey(`${check} `.padEnd(38, '.') + ' ') + c.green('OK'));
      await this.flush();
      await sleep(120 + Math.random() * 180);
    }

    const user = await this.backend.restore();
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
  const sound = new ConsoleSound({ startUrl: root.dataset.soundStart, loopUrl: root.dataset.soundLoop });
  shell.sound = sound;
  shell.articlesUrl = root.dataset.articles ?? '';
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

  // browsers only allow audio after a gesture, so the terminal "powers on" with a click
  const toggle = document.getElementById('rp-console-sound');
  const syncToggle = () => {
    if (!toggle) return;
    toggle.hidden = !sound.supported;
    toggle.setAttribute('aria-pressed', String(sound.enabled));
    toggle.textContent = sound.enabled ? '🔊 Звук: вкл' : '🔇 Звук: выкл';
  };
  syncToggle();
  toggle?.addEventListener('click', () => {
    sound.setEnabled(!sound.enabled);
    syncToggle();
  });
  const setEnabled = sound.setEnabled.bind(sound);
  sound.setEnabled = (value) => {
    setEnabled(value);
    syncToggle();
  };

  window.addEventListener('pagehide', () => sound.stop());

  const gate = document.createElement('button');
  gate.type = 'button';
  gate.className = 'rp-console-power';
  gate.textContent = sound.enabled && sound.supported ? '[ ВКЛЮЧИТЬ ТЕРМИНАЛ ]' : '[ ЗАПУСТИТЬ ТЕРМИНАЛ ]';
  root.append(gate);
  gate.focus({ preventScroll: true });

  await new Promise((resolve) => {
    gate.addEventListener('click', resolve, { once: true });
  });
  gate.remove();

  sound.unlock();
  void sound.start();
  term.focus();
  await shell.boot();
}
