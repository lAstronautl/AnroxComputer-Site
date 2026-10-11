/**
 * Отделы и коды допуска. ВАЖНО: держите в соответствии с `_data/console.yml`
 * (разделы `departments` и `codes`) — сервер не доверяет уровням, которые присылает браузер.
 */

export const DEPARTMENTS = {
  staff: { name: 'Рядовой сотрудник', level: 1 },
  osn: { name: 'ОСН — отряд специального назначения', level: 2 },
  otkb: { name: 'ОтКБ — отряд корпоративной безопасности', level: 2 },
  dzis: { name: 'ДЗИС — департамент защиты интеллектуальной собственности', level: 2 },
  dkb: { name: 'ДКБ — департамент корпоративной безопасности', level: 2 }
};

export const CODES = [
  { code: 'ВЕКТОР-7', level: 3 },
  { code: 'РУБИН-12', level: 4 },
  { code: 'ЧЁРНАЯ-ЖЕОДА', level: 5 }
];

export const ACTIONS = new Set(['read', 'denied', 'bad-code', 'auth', 'hack-failed', 'article']);
