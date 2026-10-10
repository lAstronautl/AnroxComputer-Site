---
layout: page
title: Редактор
icon: fas fa-file-pen
order: 8
compress_html: false
---

Админ панель

<div id="post-editor" class="post-editor" data-repo="{{ site.post_editor.repo }}" data-branch="{{ site.post_editor.branch | default: 'master' }}">
  <section id="pe-auth" class="pe-auth">
    <label>GitHub Personal Access Token
      <input type="password" id="pe-token" placeholder="github_pat_...">
    </label>
    <label>Repository (owner/name)
      <input type="text" id="pe-repo" value="{{ site.post_editor.repo }}" disabled>
    </label>
    <button type="button" id="pe-connect">Подключиться</button>
    <button type="button" id="pe-disconnect" hidden>Выйти</button>
    <span id="pe-auth-status"></span>
  </section>

  <section id="pe-workspace" class="pe-workspace" hidden>
    <div class="pe-editor-tabs" role="tablist">
      <button type="button" id="pe-tab-post" class="pe-editor-tab is-active" role="tab" aria-selected="true">Пост</button>
      <button type="button" id="pe-tab-map" class="pe-editor-tab" role="tab" aria-selected="false">Карта</button>
    </div>

    <div id="pe-panel-post" class="pe-panel" role="tabpanel">
      <div class="pe-post-layout">
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
number: 1
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
      </div>
    </div>

    <div id="pe-panel-map" class="pe-panel" hidden role="tabpanel">
      <p class="pe-map-hint">Загрузите изображение, кликами отметьте точки полигона для зоны (минимум 3 точки), затем кнопкой «Завершить зону» закройте полигон и заполните поля. Готовый YAML можно сразу вставить в текст поста.</p>

      <div id="map-editor" class="map-editor">
        <div class="map-editor-controls">
          <input type="file" id="map-editor-file" accept="image/*" />
          <button type="button" id="map-editor-finish" disabled>Завершить зону</button>
          <button type="button" id="map-editor-undo" disabled>Отменить точку</button>
          <button type="button" id="map-editor-clear" disabled>Очистить всё</button>
        </div>
        <div class="map-editor-canvas-wrap" id="map-editor-canvas-wrap">
          <svg id="map-editor-svg" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
        </div>
        <div class="map-editor-zones" id="map-editor-zones"></div>
        <h3>Результат</h3>
        <textarea id="map-editor-output" class="map-editor-output" readonly="readonly" rows="14" placeholder="YAML появится здесь после добавления зон..."></textarea>
        <div class="map-editor-controls">
          <button type="button" id="map-editor-copy">Скопировать YAML</button>
          <button type="button" id="pe-map-insert">Вставить YAML в текст поста</button>
        </div>
      </div>
    </div>
  </section>
</div>

<script src="{{ '/assets/js/dist/map-editor.min.js' | relative_url }}"></script>
<script src="{{ '/assets/js/dist/post-editor.min.js' | relative_url }}"></script>
