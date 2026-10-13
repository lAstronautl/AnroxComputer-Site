/**
 * Порог админ-команд. ВАЖНО: держите в соответствии с `_data/console.yml` (раздел `admin_level`) —
 * сервер не доверяет уровням, которые присылает браузер. Отдел сотрудники вписывают сами, списка нет.
 */

// с этого уровня доступны promote, demote, transfer, resetpass, fire, broadcast (adduser — всем вошедшим, но не выше своего уровня)
export const ADMIN_LEVEL = 10;
export const MAX_LEVEL = 100;

export const ACTIONS = new Set(['read', 'denied', 'bad-code', 'hack-failed', 'article']);
