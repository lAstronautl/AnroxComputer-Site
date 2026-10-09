---
layout: page
title: Редактор карт
icon: fas fa-map-location-dot
order: 7
compress_html: false
---

Загрузите изображение, кликами отметьте точки полигона для зоны (минимум 3 точки), затем двойным кликом (или кнопкой «Завершить зону») закройте полигон и заполните поля. В конце скопируйте сгенерированный YAML-блок в front matter поста (`interactive_map:`).

<div id="map-editor" class="map-editor">
  <div class="map-editor-controls">
    <input type="file" id="map-editor-file" accept="image/*" />
    <button type="button" id="map-editor-finish" disabled>Завершить зону</button>
    <button type="button" id="map-editor-undo" disabled>Отменить точку</button>
    <button type="button" id="map-editor-clear" disabled>Очистить всё</button>
  </div>
  <div class="map-editor-canvas-wrap">
    <img id="map-editor-img" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7" alt="Загруженная карта" hidden="hidden" />
    <svg id="map-editor-svg" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
  </div>
  <div class="map-editor-zones" id="map-editor-zones"></div>
  <h3>Результат</h3>
  <textarea id="map-editor-output" class="map-editor-output" readonly="readonly" rows="14" placeholder="YAML появится здесь после добавления зон..."></textarea>
  <button type="button" id="map-editor-copy">Скопировать YAML</button>
</div>
<script src="{{ '/assets/js/dist/map-editor.min.js' | relative_url }}"></script>
