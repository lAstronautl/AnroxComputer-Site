---
layout: page
title: Консоль
icon: fas fa-terminal
order: 9
compress_html: false
---

<p class="rp-console-hint">
  Закрытая корпоративная сеть АнКо. Зарегистрируйтесь как сотрудник, ищите секретные файлы и играйте в перерывах.
  Введите <code>help</code>, чтобы увидеть команды.
</p>

<button type="button" id="rp-console-sound" class="rp-console-sound-toggle" aria-pressed="true" hidden>🔊 Звук: вкл</button>

<div id="rp-console" class="rp-console" aria-label="Корпоративная консоль"
  data-sound-start="{{ '/assets/audio/console-start.mp3' | relative_url }}"
  data-sound-loop="{{ '/assets/audio/console-loop.mp3' | relative_url }}"
  data-articles="{{ '/assets/js/data/console-articles.json' | relative_url }}">
  <div class="rp-console-screen"></div>
</div>

<script type="application/json" id="rp-console-data">{{ site.data.console | jsonify }}</script>
<script src="{{ '/assets/js/dist/console.min.js' | relative_url }}"></script>
