---
layout: editor
title: Консоль
icon: fas fa-terminal
order: 9
compress_html: false
---

<div class="console-window">
  <header class="console-window-bar">
    <a class="console-window-back" href="{{ '/' | relative_url }}">◄ На сайт</a>
    <span class="console-window-title">АнКо // корпоративная консоль</span>
    <span class="console-window-hint">help — список команд</span>
    <button type="button" id="rp-console-sound" class="rp-console-sound-toggle" aria-pressed="true" hidden>🔊 Звук: вкл</button>
  </header>

  <div id="rp-console" class="rp-console" aria-label="Корпоративная консоль"
    data-home="{{ '/' | relative_url }}"
    data-sound-start="{{ '/assets/audio/console-start.mp3' | relative_url }}"
    data-sound-loop="{{ '/assets/audio/console-loop.mp3' | relative_url }}"
    data-articles="{{ '/assets/js/data/console-articles.json' | relative_url }}">
    <div class="rp-console-screen"></div>
  </div>
</div>

<script type="application/json" id="rp-console-data">{{ site.data.console | jsonify }}</script>
<script src="{{ '/assets/js/dist/console.min.js' | relative_url }}"></script>
