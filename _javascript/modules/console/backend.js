/**
 * Where the console keeps employees and the journal.
 * - LocalBackend: this browser's localStorage (works with no server, nothing is shared).
 * - RemoteBackend: the Cloudflare Worker API from `worker/` (shared for everyone, set `api_url` in console.yml).
 * Both have the same async interface; failures come back as `{ error: '<code>' }`.
 */

import {
  createUser,
  deleteUser,
  getSessionName,
  getUser,
  loadUsers,
  logAttempt,
  setPassword,
  setSessionName,
  updateUser,
  verifyUser
} from './storage';

const TOKEN_KEY = 'anco-console-token';

const MAIL_KEY = 'anco-console-mail';

function loadMail() {
  try {
    return JSON.parse(localStorage.getItem(MAIL_KEY) ?? 'null') ?? {};
  } catch {
    return {};
  }
}

function saveMail(all) {
  try {
    localStorage.setItem(MAIL_KEY, JSON.stringify(all));
  } catch {
    // storage blocked: letters just will not persist
  }
}

const mailKey = (name) => name.trim().toLowerCase();

/** The user with the unread-letters counter the prompt shows. */
function withUnread(user) {
  if (!user) return user;
  const box = loadMail()[mailKey(user.name)] ?? [];
  return { ...user, unread: box.filter((letter) => !letter.read).length };
}

// readable password without look-alike characters (no 0/O, 1/l/I)
function generatePassword(length = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export class LocalBackend {
  constructor(data) {
    this.data = data;
    this.remote = false;
  }

  async login(name, password) {
    const user = await verifyUser(name, password);
    if (!user) return { error: 'credentials' };
    setSessionName(user.name);
    return { user };
  }

  async restore() {
    const stored = getSessionName();
    return stored ? withUnread(getUser(stored)) : null;
  }

  async refresh(user) {
    return withUnread(getUser(user.name) ?? user);
  }

  async logout() {
    setSessionName(null);
  }

  async log(user, entry) {
    logAttempt(user.name, entry);
    return withUnread(getUser(user.name) ?? user);
  }

  async saveStats(user, patch) {
    return withUnread(updateUser(user.name, { stats: { ...(user.stats ?? {}), ...patch } }) ?? user);
  }

  async unlock(user, keyword) {
    if ((user.codes ?? []).includes(keyword)) return { error: 'already' };
    updateUser(user.name, { codes: [...(user.codes ?? []), keyword] });
    logAttempt(user.name, { action: 'auth', target: keyword });
    return { user: withUnread(getUser(user.name)) };
  }

  async addUser(actor, { name, realName, department, level, password }) {
    if (level > actor.level) return { error: 'too-high' };

    const user = await createUser({ name, realName, department: department.name, password, level });
    if (!user) return { error: 'taken' };
    logAttempt(actor.name, { action: 'adduser', target: `${user.name} L${level}` });
    return { created: { name: user.name, department: user.department, level } };
  }

  /** The employee an admin may manage: exists, is not the admin, ranks below them. */
  manageable(actor, name) {
    if (actor.level < (this.data.admin_level ?? 10)) return { error: 'forbidden' };
    const target = getUser(name);
    if (!target) return { error: 'not-found' };
    if (target.name === actor.name) return { error: 'self' };
    if (target.level >= actor.level) return { error: 'above' };
    return { target };
  }

  async staff(actor) {
    const seeReal = actor.level >= (this.data.admin_level ?? 10);
    return {
      staff: Object.values(loadUsers())
        .map(({ name, realName, department, level }) => ({ name, department, level, ...(seeReal ? { realName: realName ?? '' } : {}) }))
        .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name, 'ru'))
    };
  }

  async setName(actor, name, realName) {
    let target = actor;
    if (name && name.toLowerCase() !== actor.name.toLowerCase()) {
      const found = this.manageable(actor, name);
      if (found.error) return { error: found.error };
      target = found.target;
    }

    updateUser(target.name, { realName });
    logAttempt(actor.name, { action: 'setname', target: target.name });
    return { target: { name: target.name } };
  }

  async promote(actor, name, level) {
    const { target, error } = this.manageable(actor, name);
    if (error) return { error };

    const wanted = level ?? target.level + 1;
    if (wanted > actor.level) return { error: 'too-high' };
    if (wanted <= target.level) return { error: 'not-higher' };

    updateUser(target.name, { level: wanted });
    logAttempt(actor.name, { action: 'promote', target: `${target.name} L${target.level}→L${wanted}` });
    return { target: { name: target.name, level: wanted } };
  }

  async demote(actor, name, level) {
    const { target, error } = this.manageable(actor, name);
    if (error) return { error };

    const wanted = level ?? target.level - 1;
    if (wanted < 0) return { error: 'bad-level' };
    if (wanted >= target.level) return { error: 'not-lower' };

    updateUser(target.name, { level: wanted });
    logAttempt(actor.name, { action: 'demote', target: `${target.name} L${target.level}→L${wanted}` });
    return { target: { name: target.name, level: wanted } };
  }

  async transfer(actor, name, department) {
    const { target, error } = this.manageable(actor, name);
    if (error) return { error };

    updateUser(target.name, { department: department.name });
    logAttempt(actor.name, { action: 'transfer', target: `${target.name} → ${department.name}` });
    return { target: { name: target.name, department: department.name } };
  }

  async resetPassword(actor, name, password) {
    const { target, error } = this.manageable(actor, name);
    if (error) return { error };

    const generated = password === '';
    const next = generated ? generatePassword() : password;
    await setPassword(target.name, next);
    logAttempt(actor.name, { action: 'resetpass', target: target.name });
    return { target: { name: target.name }, ...(generated ? { password: next } : {}) };
  }

  async fire(actor, name) {
    const { target, error } = this.manageable(actor, name);
    if (error) return { error };

    deleteUser(target.name);
    logAttempt(actor.name, { action: 'fire', target: `${target.name} L${target.level}` });
    return { target: { name: target.name } };
  }

  async mailList(user) {
    const box = loadMail()[mailKey(user.name)] ?? [];
    return { mail: [...box].reverse().slice(0, 50).map(({ id, from, subject, t, read }) => ({ id, from, subject, t, read })) };
  }

  async mailRead(user, id) {
    const all = loadMail();
    const letter = (all[mailKey(user.name)] ?? []).find((item) => item.id === id);
    if (!letter) return { error: 'not-found' };
    letter.read = true;
    saveMail(all);
    return { message: { id, from: letter.from, subject: letter.subject, body: letter.body, t: letter.t } };
  }

  deliver(all, toName, from, subject, body) {
    const key = mailKey(toName);
    const box = all[key] ?? [];
    box.push({ id: Date.now() * 1000 + Math.floor(Math.random() * 1000), from, subject, body, t: Date.now(), read: false });
    all[key] = box.slice(-100);
  }

  async mailSend(user, { to, subject, body }) {
    const target = getUser(to);
    if (!target) return { error: 'not-found' };
    if (target.name === user.name) return { error: 'self' };

    const all = loadMail();
    this.deliver(all, target.name, user.name, subject, body);
    saveMail(all);
    return { sent: { to: target.name } };
  }

  async mailDelete(user, id) {
    const all = loadMail();
    all[mailKey(user.name)] = (all[mailKey(user.name)] ?? []).filter((item) => item.id !== id);
    saveMail(all);
    return { ok: true };
  }

  async broadcast(actor, { subject, body }) {
    if (actor.level < (this.data.admin_level ?? 10)) return { error: 'forbidden' };

    const all = loadMail();
    const others = Object.values(loadUsers()).filter((person) => person.name !== actor.name);
    for (const person of others) this.deliver(all, person.name, actor.name, subject, body);
    saveMail(all);
    logAttempt(actor.name, { action: 'broadcast', target: subject });
    return { sent: { count: others.length } };
  }

  async remove(user) {
    deleteUser(user.name);
    setSessionName(null);
  }
}

export class RemoteBackend {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.remote = true;
    this.token = null;
    try {
      this.token = sessionStorage.getItem(TOKEN_KEY);
    } catch {
      // session storage blocked: the sign-in just will not survive a reload
    }
  }

  setToken(token) {
    this.token = token;
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
  }

  async call(method, path, body) {
    try {
      const response = await fetch(`${this.base}${path}`, {
        method,
        cache: 'no-store',
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { error: data.error ?? 'server', status: response.status };
      return data;
    } catch {
      return { error: 'network' };
    }
  }

  async open(result) {
    if (result.error) return result;
    this.setToken(result.token);
    return { user: result.user };
  }

  async login(name, password) {
    return this.open(await this.call('POST', '/api/login', { name, password }));
  }

  async restore() {
    if (!this.token) return null;
    const result = await this.call('GET', '/api/me');
    if (result.error === 'unauthorized') this.setToken(null);
    return result.user ?? null;
  }

  async refresh(user) {
    const result = await this.call('GET', '/api/me');
    return result.user ?? user;
  }

  async logout() {
    if (this.token) await this.call('POST', '/api/logout');
    this.setToken(null);
  }

  async log(user, entry) {
    const result = await this.call('POST', '/api/log', entry);
    return result.user ?? user;
  }

  async saveStats(user, patch) {
    const result = await this.call('POST', '/api/stats', patch);
    return result.user ?? user;
  }

  async unlock(user, keyword) {
    return this.call('POST', '/api/unlock', { keyword });
  }

  async mailList() {
    return this.call('GET', '/api/mail');
  }

  async mailRead(user, id) {
    return this.call('GET', `/api/mail/${id}`);
  }

  async mailSend(user, { to, subject, body }) {
    return this.call('POST', '/api/mail', { to, subject, body });
  }

  async mailDelete(user, id) {
    return this.call('DELETE', `/api/mail/${id}`);
  }

  async broadcast(actor, { subject, body }) {
    return this.call('POST', '/api/broadcast', { subject, body });
  }

  async addUser(actor, { name, realName, department, level, password }) {
    return this.call('POST', '/api/adduser', { name, realName, customDepartment: department.name, level, password });
  }

  async staff() {
    return this.call('GET', '/api/staff');
  }

  async setName(actor, name, realName) {
    return this.call('POST', '/api/setname', { name, realName });
  }

  async promote(actor, name, level) {
    return this.call('POST', '/api/promote', { name, level });
  }

  async demote(actor, name, level) {
    return this.call('POST', '/api/demote', { name, level });
  }

  async transfer(actor, name, department) {
    return this.call('POST', '/api/transfer', { name, customDepartment: department.name });
  }

  async resetPassword(actor, name, password) {
    return this.call('POST', '/api/resetpass', { name, password });
  }

  async fire(actor, name) {
    return this.call('POST', '/api/fire', { name });
  }

  async remove() {
    await this.call('DELETE', '/api/me');
    this.setToken(null);
  }
}

export function createBackend(data) {
  const url = String(data.api_url ?? '').trim();
  return url ? new RemoteBackend(url) : new LocalBackend(data);
}
