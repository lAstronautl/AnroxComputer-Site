"""Собирает worker/bundle/worker.js — один файл для вставки в панель Cloudflare."""
import re

cfg = open('worker/src/config.js', encoding='utf-8').read()
idx = open('worker/src/index.js', encoding='utf-8').read()
cfg = re.sub(r'/\*\*.*?\*/\n\n', '', cfg, count=1, flags=re.S).replace('export const', 'const')
eco = open('worker/src/economy.js', encoding='utf-8').read()
eco = re.sub(r'/\*\*.*?\*/\n\n', '', eco, count=1, flags=re.S).replace('export const', 'const').replace('export function', 'function')
idx = re.sub(r"import \{[^}]*\} from './(config|economy).js';\n", '', idx)
head = ('// Единый файл для вставки в редактор Worker в панели Cloudflare (собран из src/config.js + src/economy.js + src/index.js).\n'
        '// Не правьте вручную: меняйте src/ и пересобирайте (python3 worker/build-bundle.py).\n\n')
open('worker/bundle/worker.js', 'w', encoding='utf-8').write(head + cfg + '\n' + eco + '\n' + idx)
