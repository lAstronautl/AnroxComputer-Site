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
  logAttempt,
  setSessionName,
  updateUser,
  verifyUser
} from './storage';

const TOKEN_KEY = 'anco-console-token';

export class LocalBackend {
  constructor(data) {
    this.data = data;
    this.remote = false;
  }

  async register({ name, department, password }) {
    if (getUser(name)) return { error: 'taken' };
    const user = await createUser({ name, department: department.name, password, level: department.level });
    if (!user) return { error: 'taken' };
    setSessionName(user.name);
    return { user };
  }

  async login(name, password) {
    const user = await verifyUser(name, password);
    if (!user) return { error: 'credentials' };
    setSessionName(user.name);
    return { user };
  }

  async restore() {
    const stored = getSessionName();
    return stored ? getUser(stored) : null;
  }

  async refresh(user) {
    return getUser(user.name) ?? user;
  }

  async logout() {
    setSessionName(null);
  }

  async log(user, entry) {
    logAttempt(user.name, entry);
    return getUser(user.name) ?? user;
  }

  async saveStats(user, patch) {
    return updateUser(user.name, { stats: { ...(user.stats ?? {}), ...patch } }) ?? user;
  }

  async auth(user, code) {
    const entry = (this.data.codes ?? []).find((item) => item.code.toUpperCase() === code.toUpperCase());
    if (!entry) {
      logAttempt(user.name, { action: 'bad-code', target: code });
      return { error: 'invalid' };
    }
    if (entry.level <= user.level) return { error: 'already' };

    const codes = [...new Set([...(user.codes ?? []), entry.code])];
    updateUser(user.name, { level: entry.level, codes });
    logAttempt(user.name, { action: 'auth', target: `L${entry.level}` });
    return { user: getUser(user.name) };
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

  async register({ name, department, password }) {
    return this.open(await this.call('POST', '/api/register', { name, department: department.id, password }));
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

  async auth(user, code) {
    return this.call('POST', '/api/auth', { code });
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
