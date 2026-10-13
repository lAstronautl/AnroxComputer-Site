/**
 * Порог админ-команд. ВАЖНО: держите в соответствии с `_data/console.yml` (раздел `admin_level`) —
 * сервер не доверяет уровням, которые присылает браузер. Отдел сотрудники вписывают сами, списка нет.
 */

// с этого уровня доступны promote, demote, transfer, resetpass, fire, broadcast (adduser — всем вошедшим, но не выше своего уровня)
export const ADMIN_LEVEL = 10;
export const MAX_LEVEL = 999;
// с этого уровня доступно редактирование рынка (команда marketedit); держите в соответствии с `market_admin_level` в `_data/console.yml`
export const MARKET_ADMIN_LEVEL = 999;

export const ACTIONS = new Set(['read', 'denied', 'bad-code', 'hack-failed', 'article']);
