/**
 * Отделы и порог админ-команд. ВАЖНО: держите в соответствии с `_data/console.yml`
 * (разделы `departments` и `admin_level`) — сервер не доверяет уровням, которые присылает браузер.
 */

export const DEPARTMENTS = {
  staff: { name: 'Рядовой сотрудник', level: 1 },
  osn: { name: 'ОСН — отряд специального назначения', level: 2 },
  otkb: { name: 'ОтКБ — отряд корпоративной безопасности', level: 2 },
  dzis: { name: 'ДЗИС — департамент защиты интеллектуальной собственности', level: 2 },
  dkb: { name: 'ДКБ — департамент корпоративной безопасности', level: 2 }
};

// с этого уровня доступны promote, demote, transfer, resetpass, fire, broadcast (adduser — всем вошедшим, но не выше своего уровня)
export const ADMIN_LEVEL = 10;
export const MAX_LEVEL = 100;

export const ACTIONS = new Set(['read', 'denied', 'bad-code', 'hack-failed', 'article']);
