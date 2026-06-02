---
layout: editor
title: Редактор документов
icon: fas fa-pen-to-square
order: 6
---

<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
  }

  .editor-shell {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
  }

  .editor-frame {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
  }

  .editor-frame iframe {
    width: 100%;
    height: 100%;
    border: none;
    display: block;
  }
</style>

<section class="editor-shell">

  <div class="editor-frame">
    <iframe
      src="https://lastronautl.github.io/AnroxComputers-DE/"
      title="AnroxComputers document editor"
      loading="lazy"
      allow="clipboard-read; clipboard-write"
    ></iframe>
  </div>
</section>
