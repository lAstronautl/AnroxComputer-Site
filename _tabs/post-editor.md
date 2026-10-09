---
layout: page
title: Редактор постов
icon: fas fa-file-pen
order: 8
---

Редактор работает напрямую с GitHub через ваш персональный токен (PAT) — публикация делает настоящий commit в репозиторий. Токен хранится только в localStorage этого браузера и никуда, кроме api.github.com, не отправляется.

<div id="post-editor" class="post-editor">
  <section id="pe-auth" class="pe-auth">
    <p class="pe-warning">
      ⚠ Используйте токен с минимальными правами (Fine-grained PAT, доступ только к этому репозиторию, права Contents: Read and write). Токен виден в DevTools любому, кто имеет доступ к этому браузеру/устройству.
    </p>
    <label>GitHub Personal Access Token
      <input type="password" id="pe-token" placeholder="github_pat_...">
    </label>
    <label>Repository (owner/name)
      <input type="text" id="pe-repo" value="lAstronautl/AnroxComputer-Site">
    </label>
    <label>Branch
      <input type="text" id="pe-branch" value="master">
    </label>
    <button type="button" id="pe-connect">Подключиться</button>
    <button type="button" id="pe-disconnect" hidden>Выйти</button>
    <span id="pe-auth-status"></span>
  </section>

  <section id="pe-workspace" class="pe-workspace" hidden>
    <div class="pe-sidebar">
      <button type="button" id="pe-new-post">+ Новый пост</button>
      <input type="text" id="pe-filter" placeholder="Фильтр по названию...">
      <ul id="pe-post-list" class="pe-post-list"></ul>
    </div>

    <div class="pe-main">
      <label>Путь файла (_posts/Название.md)
        <input type="text" id="pe-filename" placeholder="_posts/Новый-пост.md">
      </label>

      <div class="pe-toolbar">
        <button type="button" id="pe-insert-map">Вставить интерактивную карту</button>
        <button type="button" id="pe-preview-toggle">Показать превью</button>
      </div>

      <div class="pe-editor-area">
        <textarea id="pe-content" spellcheck="false" placeholder="---
title: Заголовок поста
date: 2026-01-01 12:00:00 +0800
categories:
  - Категория
tags:
  - graph
---

Текст поста..."></textarea>
        <div id="pe-preview" class="pe-preview" hidden></div>
      </div>

      <label>Сообщение коммита
        <input type="text" id="pe-commit-message" placeholder="Обновление поста ...">
      </label>

      <button type="button" id="pe-save" disabled>Сохранить и закоммитить</button>
      <span id="pe-save-status"></span>
    </div>
  </section>

  <section id="pe-map-modal" class="pe-map-modal" hidden>
    <div class="pe-map-modal-inner">
      <button type="button" id="pe-map-close" class="pe-map-modal-close">×</button>
      <iframe id="pe-map-frame" src="{{ '/map-editor/' | relative_url }}" title="Редактор карт"></iframe>
      <button type="button" id="pe-map-insert">Вставить YAML в текст поста</button>
    </div>
  </section>
</div>

<script src="{{ '/assets/js/dist/post-editor.min.js' | relative_url }}"></script>
