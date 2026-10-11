-- Схема базы D1 для консоли АнКо. Выполняется один раз (см. worker/README.md).

CREATE TABLE IF NOT EXISTS users (
  key          TEXT PRIMARY KEY,            -- позывной в нижнем регистре
  name         TEXT NOT NULL,
  real_name    TEXT NOT NULL DEFAULT '',   -- настоящее имя человека; видят только администраторы
  department   TEXT NOT NULL,
  salt         TEXT NOT NULL,
  hash         TEXT NOT NULL,               -- PBKDF2-SHA256
  base_level   INTEGER NOT NULL,
  level        INTEGER NOT NULL,
  codes        TEXT NOT NULL DEFAULT '[]',  -- введённые коды допуска (JSON)
  snake        INTEGER NOT NULL DEFAULT 0,
  hacks        INTEGER NOT NULL DEFAULT 0,
  fails        INTEGER NOT NULL DEFAULT 0,  -- подряд неудачных входов
  locked_until INTEGER NOT NULL DEFAULT 0,  -- мс, до какого времени вход заблокирован
  registered   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,              -- SHA-256 токена (сам токен в базе не хранится)
  user_key   TEXT NOT NULL,
  expires    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key TEXT NOT NULL,
  t        INTEGER NOT NULL,
  action   TEXT NOT NULL,
  target   TEXT
);

CREATE INDEX IF NOT EXISTS attempts_user ON attempts (user_key, id);

CREATE TABLE IF NOT EXISTS mail (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  to_key    TEXT NOT NULL,
  from_name TEXT NOT NULL,
  subject   TEXT NOT NULL,
  body      TEXT NOT NULL,
  t         INTEGER NOT NULL,
  is_read   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS mail_to ON mail (to_key, id);
