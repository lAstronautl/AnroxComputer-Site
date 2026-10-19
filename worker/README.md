# API консоли АнКо (Cloudflare Worker + D1)

Хранит сотрудников, сессии и журнал обращений для вкладки «Консоль». Пока `api_url` в
`_data/console.yml` пустой, консоль работает как раньше — аккаунты лежат только в браузере игрока.

## Что нужно один раз

1. Бесплатный аккаунт на <https://dash.cloudflare.com/sign-up> (карта не нужна).
2. Node.js 18+ на вашем компьютере.

## Развёртывание

Все команды — из папки `worker/`:

```bash
cd worker

# 1. войти в Cloudflare (откроется браузер)
npx wrangler login

# 2. создать базу; в ответе будет database_id — вставьте его в wrangler.toml
npx wrangler d1 create anroxcomputers

# 3. создать таблицы
npx wrangler d1 execute anroxcomputers --remote --file=schema.sql

# 4. выложить API; в конце будет адрес вида https://anco-console.<имя>.workers.dev
npx wrangler deploy
```

Затем:

1. В `wrangler.toml` проверьте `ALLOWED_ORIGINS` — там адрес сайта (`https://lastronautl.github.io`, без `/` в конце).
   Если меняли — снова `npx wrangler deploy`.
2. В `_data/console.yml` укажите адрес из шага 4:
   ```yaml
   api_url: "https://anco-console.<имя>.workers.dev"
   ```
3. Закоммитьте и выложите сайт.
4. **Первый аккаунт.** Открытой регистрации нет: новые сотрудники создаются командой `adduser` в консоли.
   Самый первый аккаунт (пока в базе нет ни одного) создаётся один раз запросом — он получает уровень 10:
   ```bash
   curl -X POST https://<адрес-воркера>/api/register -H "Content-Type: application/json" \
     -d '{"name":"Позывной","password":"пароль","customDepartment":"Администрация","realName":"Имя Фамилия"}'
   ```
   После этого `/api/register` отвечает «closed» для всех.

Проверка: откройте адрес воркера в браузере — должно быть `{"ok":true,"service":"anco-console"}`.

## Без терминала (только через сайт Cloudflare)

1. **Таблицы.** D1 → anroxcomputers → вкладка **Console** → вставьте содержимое `schema.sql`
   (без строк-комментариев `--`) и нажмите Execute. Если консоль принимает по одному запросу — выполняйте
   каждый `CREATE …;` отдельно.
2. **Воркер.** Workers & Pages → Create → Create Worker → имя `anco-console` → Deploy → Edit code:
   замените весь код на содержимое `worker/bundle/worker.js` → Deploy.
3. **База.** Воркер → Settings → Bindings → Add → D1 database: имя переменной `DB`, база `anroxcomputers`.
4. **Переменные.** Там же Settings → Variables: `ALLOWED_ORIGINS` = `https://lastronautl.github.io`
   (и при желании `ALLOW_LOCALHOST` = `true`). После изменений нажмите Deploy.
5. Адрес воркера (`https://anco-console.<имя>.workers.dev`) впишите в `api_url` в `_data/console.yml`.

После правки `src/` пересоберите единый файл: `python3 worker/build-bundle.py`.

## Живые комнаты (WebSocket, меньше пинг)

«Танчики», «Трон» и «Змейка» по умолчанию синхронизируются опросом (запрос раз в ~0,3 с). Чтобы сервер сам
присылал состояние по WebSocket, нужен Durable Object `ArenaRoom` (он уже есть в коде, привязка описана в
`wrangler.toml`). Достаточно один раз задеплоить воркер через wrangler:

```bash
cd worker
npx wrangler deploy
```

Wrangler сам создаст миграцию и привязку `ARENA`. На бесплатном тарифе Durable Objects доступны (с хранилищем SQLite).
Если привязки нет, ничего не ломается: консоль сама остаётся на опросе. Деньги и итоги боя по-прежнему пишутся в D1,
но только раз в пару секунд и в конце боя, а не на каждый такт.

## Обновление базы (если таблицы уже созданы раньше)

Имена сотрудников (`real_name`) и почта добавлялись позже. В D1 → Console выполните то, чего ещё нет:

```sql
ALTER TABLE users ADD COLUMN real_name TEXT NOT NULL DEFAULT '';
```

(Таблица `mail` — см. `schema.sql`.) Настоящие имена видят только сотрудники уровня 10 и выше:
сервер просто не отдаёт их остальным, в консоли в списке `staff` вместо них мерцают случайные знаки.

## Как это устроено

- Пароли хешируются на сервере (PBKDF2-SHA256, соль у каждого), в браузере остаётся только токен сессии на 7 дней.
- 5 неверных паролей подряд блокируют вход на минуту.
- `adduser` — не больше 2 новых аккаунтов в сутки с одного сотрудника (`ADDUSER_PER_DAY` в `src/index.js`).
- Уровень допуска проверяет сервер. Команды `adduser` и `promote` доступны с уровня 10 и выше,
  выдать можно не выше собственного уровня. **Порог (`ADMIN_LEVEL`) лежит в `src/config.js` —
  при изменении `admin_level` в `_data/console.yml` обновляйте и этот файл,
  затем пересоберите `bundle/worker.js` и задеплойте заново.**
- В журнале хранятся действия `read`, `denied`, `hack-failed`, `article`, а у администраторов ещё `adduser` и `promote` (последние 200 на сотрудника).
- Если сервер недоступен, консоль пишет «Сервер недоступен» и ничего не сохраняет локально — аккаунты не расходятся.

## Админские запросы

```bash
# сотрудники
npx wrangler d1 execute anroxcomputers --remote --command "SELECT name, department, level, snake, hacks FROM users"

# последние обращения по всем
npx wrangler d1 execute anroxcomputers --remote --command "SELECT u.name, a.action, a.target, datetime(a.t/1000,'unixepoch') AS at FROM attempts a JOIN users u ON u.key=a.user_key ORDER BY a.id DESC LIMIT 50"

# выдать уровень (первого администратора нужно назначить так, дальше он сам повышает других командой promote)
npx wrangler d1 execute anroxcomputers --remote --command "UPDATE users SET level = 10 WHERE key='тест'"

# удалить сотрудника (позывной в нижнем регистре)
npx wrangler d1 execute anroxcomputers --remote --command "DELETE FROM users WHERE key='тест'"

# сбросить пароль и блокировку входа нельзя «одной строкой» — проще удалить сотрудника, он зарегистрируется заново
```

Те же данные видны в панели Cloudflare: Storage & Databases → D1 → anroxcomputers.

## Локальная проверка

`npx wrangler dev` запускает API на `http://localhost:8787` (с локальной базой:
`npx wrangler d1 execute anroxcomputers --local --file=schema.sql`). Для сайта на localhost
в `wrangler.toml` включён `ALLOW_LOCALHOST`; в боевой версии его можно убрать.

## Рынок: уровень 999

Биржа и казино хранят данные в D1 (таблицы создаются сами). Править рынок (новости, цены, новые компании — команда `marketedit` или клавиша `E` на экране биржи) может только сотрудник с уровнем 999. Выдаётся в консоли D1:

```sql
UPDATE users SET level = 999 WHERE key = 'позывной_в_нижнем_регистре';
```

Необязательно: переменная `MARKET_SEED` (любая случайная строка) в настройках Worker — чтобы цены нельзя было предсказать по коду.
