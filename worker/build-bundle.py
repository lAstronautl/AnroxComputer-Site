"""Собирает worker/bundle/worker.js — один файл для вставки в панель Cloudflare."""
import re

cfg = open('worker/src/config.js', encoding='utf-8').read()
idx = open('worker/src/index.js', encoding='utf-8').read()
cfg = re.sub(r'/\*\*.*?\*/\n\n', '', cfg, count=1, flags=re.S).replace('export const', 'const')
idx = idx.replace("import { ACTIONS, CODES, DEPARTMENTS } from './config.js';\n", '')
head = ('// Единый файл для вставки в редактор Worker в панели Cloudflare (собран из src/config.js + src/index.js).\n'
        '// Не правьте вручную: меняйте src/ и пересобирайте (python3 worker/build-bundle.py).\n\n')
open('worker/bundle/worker.js', 'w', encoding='utf-8').write(head + cfg + '\n' + idx)
