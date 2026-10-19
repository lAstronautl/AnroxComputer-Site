"""Собирает worker/bundle/worker.js — один файл для вставки в панель Cloudflare."""
import re

cfg = open('worker/src/config.js', encoding='utf-8').read()
idx = open('worker/src/index.js', encoding='utf-8').read()
cfg = re.sub(r'/\*\*.*?\*/\n\n', '', cfg, count=1, flags=re.S).replace('export const', 'const')
eco = open('worker/src/economy.js', encoding='utf-8').read()
eco = re.sub(r'/\*\*.*?\*/\n\n', '', eco, count=1, flags=re.S).replace('export const', 'const').replace('export function', 'function')
liar = open('worker/src/liar.js', encoding='utf-8').read()
liar = re.sub(r'/\*\*.*?\*/\n\n', '', liar, count=1, flags=re.S).replace('export const', 'const').replace('export function', 'function')
tanks = open('worker/src/tanks.js', encoding='utf-8').read()
tanks = re.sub(r'/\*\*.*?\*/\n\n', '', tanks, count=1, flags=re.S).replace('export const', 'const').replace('export function', 'function')
arcade = open('worker/src/arcade.js', encoding='utf-8').read()
arcade = re.sub(r'/\*\*.*?\*/\n\n', '', arcade, count=1, flags=re.S).replace('export const', 'const').replace('export function', 'function')
idx = re.sub(r"import \{[^}]*\} from './(config|economy|liar|tanks|arcade).js';\n", '', idx)
head = ('// Единый файл для вставки в редактор Worker в панели Cloudflare (собран из src/config.js + src/economy.js + src/liar.js + src/tanks.js + src/arcade.js + src/index.js).\n'
        '// Не правьте вручную: меняйте src/ и пересобирайте (python3 worker/build-bundle.py).\n\n')
open('worker/bundle/worker.js', 'w', encoding='utf-8').write(head + cfg + '\n' + eco + '\n' + liar + '\n' + tanks + '\n' + arcade + '\n' + idx)
