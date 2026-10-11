/**
 * Standalone visual editor for building interactive-map zone data.
 * Load an image, click points to build a polygon zone, fill in its
 * metadata, repeat, then copy the generated YAML into a post's front
 * matter under `interactive_map:`.
 */

function escapeYaml(value) {
  return String(value ?? '').replace(/"/g, '\\"');
}

// Distinct colours handed out to zones in turn; each zone can be recoloured.
const ZONE_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#46f0f0',
  '#f032e6',
  '#ffe119',
  '#bcf60c',
  '#008080'
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function buildYaml(imagePath, zones) {
  if (zones.length === 0) return '';

  const lines = ['interactive_map:', `  image: ${imagePath || '/assets/img/posts/your-map.png'}`, '  zones:'];

  for (const zone of zones) {
    const points = zone.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    lines.push(`    - points: "${points}"`);
    lines.push(`      title: "${escapeYaml(zone.title)}"`);
    if (HEX_COLOR.test(zone.color ?? '')) lines.push(`      color: "${zone.color.toLowerCase()}"`);
    if (zone.link) {
      lines.push(`      link: "${escapeYaml(zone.link)}"`);
    } else {
      lines.push(`      text: "${escapeYaml(zone.text)}"`);
    }
  }

  return lines.join('\n');
}

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (v.length >= 2 && v.startsWith('\'') && v.endsWith('\'')) {
    return v.slice(1, -1).replace(/''/g, '\'');
  }
  return v;
}

function parsePoints(value) {
  return value
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number))
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .map(([x, y]) => ({ x, y }));
}

/**
 * Reads the YAML produced by `buildYaml` (the `interactive_map:` block of a
 * post, or just its `zones:` list). Only this flat shape is supported.
 */
function parseMapYaml(text) {
  const zones = [];
  let image = '';
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('- ')) {
      current = { points: [], title: '', text: '', link: '', color: '' };
      zones.push(current);
      line = line.slice(2).trim();
    }

    const match = line.match(/^(image|points|title|text|link|color):\s*(.*)$/);
    if (!match) continue;

    const [, key, raw] = match;
    const value = unquote(raw);
    if (key === 'image') image = value;
    else if (current && key === 'points') current.points = parsePoints(value);
    else if (current) current[key] = value;
  }

  return { image, zones: zones.filter((zone) => zone.points.length >= 3) };
}

let initialized = false;

export function initMapEditor() {
  if (initialized) return;

  const fileInput = document.getElementById('map-editor-file');
  const wrap = document.getElementById('map-editor-canvas-wrap');
  const svg = document.getElementById('map-editor-svg');
  const finishBtn = document.getElementById('map-editor-finish');
  const undoBtn = document.getElementById('map-editor-undo');
  const clearBtn = document.getElementById('map-editor-clear');
  const copyBtn = document.getElementById('map-editor-copy');
  const addMidBtn = document.getElementById('map-editor-add-mid');
  const delPointBtn = document.getElementById('map-editor-del-point');
  const zonesList = document.getElementById('map-editor-zones');
  const output = document.getElementById('map-editor-output');

  if (!fileInput || !wrap || !svg) return;

  initialized = true;

  // Prevent native browser image-drag-ghost and text-selection from
  // interfering with the click-to-place-point / right-click-pan interactions.
  wrap.style.userSelect = 'none';
  wrap.style.webkitUserSelect = 'none';
  wrap.addEventListener('dragstart', (event) => event.preventDefault());
  wrap.addEventListener('selectstart', (event) => event.preventDefault());

  const viewport = document.createElement('div');
  viewport.id = 'map-editor-viewport';
  viewport.className = 'map-editor-viewport';
  wrap.appendChild(viewport);

  const img = document.createElement('img');
  img.id = 'map-editor-img';
  img.className = 'map-editor-preview-img';
  img.alt = 'Загруженная карта';
  img.hidden = true;
  img.draggable = false;
  img.style.webkitUserDrag = 'none';
  img.style.userSelect = 'none';
  viewport.appendChild(img);
  viewport.appendChild(svg);

  let imagePath = '';
  let currentPoints = [];
  const zones = [];

  const NS = 'http://www.w3.org/2000/svg';

  // Point editing: `selected` is { zone: <index> | 'draft', index } or null.
  let selected = null;
  let dragging = null;
  let suppressClick = false;
  const MIN_ZONE_POINTS = 3;

  function pointsOf(zone) {
    return zone === 'draft' ? currentPoints : zones[zone]?.points;
  }

  function isSelected(zone, index) {
    return selected !== null && selected.zone === zone && selected.index === index;
  }

  // Highlights the selected square and enables/disables the point buttons.
  function refreshSelection() {
    const pts = selected ? pointsOf(selected.zone) : null;
    if (!pts || selected.index >= pts.length) selected = null;

    svg.querySelectorAll('[data-pi]').forEach((el) => {
      const zone = el.dataset.pz === 'draft' ? 'draft' : Number(el.dataset.pz);
      el.classList.toggle('is-selected', isSelected(zone, Number(el.dataset.pi)));
    });

    const minPoints = selected && selected.zone === 'draft' ? 1 : MIN_ZONE_POINTS;
    if (addMidBtn) addMidBtn.disabled = !selected || pts.length < 2;
    if (delPointBtn) delPointBtn.disabled = !selected || pts.length <= minPoints;
  }

  function syncOutput() {
    output.value = buildYaml(imagePath, zones);
  }

  // First palette colour that no other zone uses (cycles when all are taken).
  function nextColor(exceptZone) {
    const used = new Set(zones.filter((z) => z !== exceptZone).map((z) => (z.color || '').toLowerCase()));
    return ZONE_COLORS.find((c) => !used.has(c)) ?? ZONE_COLORS[zones.length % ZONE_COLORS.length];
  }

  // Zones without a valid colour (old code, hand-typed YAML) get one.
  function ensureColors() {
    for (const zone of zones) {
      if (!HEX_COLOR.test(zone.color ?? '')) zone.color = nextColor(zone);
    }
  }

  // Zoom/pan state: scale + translate (in CSS pixels) applied to `viewport`.
  let zoomScale = 1;
  let panX = 0;
  let panY = 0;
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 8;

  // Point markers keep a constant on-screen size, so they stay easy to hit
  // when zoomed out and precise when zoomed in. Re-drawn when the scale changes.
  const DRAFT_POINT_PX = 9;
  const SAVED_POINT_PX = 6;
  let renderedScale = 0;

  function applyTransform() {
    viewport.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;

    if (zoomScale !== renderedScale) {
      renderedScale = zoomScale;
      renderDraftPolygon();
      renderSavedZones();
    }
  }

  // The svg is stretched over the image (viewBox 0..100, preserveAspectRatio
  // none), so one unit is a different number of screen pixels on each axis.
  // Convert a pixel size into per-axis svg units to get a true square.
  function squareAt(point, px, className, attr) {
    const w = (px * 100) / (zoomScale * (viewport.offsetWidth || 1));
    const h = (px * 100) / (zoomScale * (viewport.offsetHeight || 1));
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', point.x - w / 2);
    rect.setAttribute('y', point.y - h / 2);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);
    rect.setAttribute('class', className);
    for (const [key, value] of Object.entries(attr)) rect.setAttribute(key, value);
    return rect;
  }

  function isInsideImage(event) {
    const rect = viewport.getBoundingClientRect();
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  }

  function svgPointFromEvent(event) {
    const rect = viewport.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = wrap.getBoundingClientRect();
    const prevScale = zoomScale;
    const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, zoomScale * factor));
    if (nextScale === prevScale) return;

    // Keep the point under the cursor stationary while zooming.
    const originX = clientX - rect.left;
    const originY = clientY - rect.top;
    panX = originX - ((originX - panX) / prevScale) * nextScale;
    panY = originY - ((originY - panY) / prevScale) * nextScale;
    zoomScale = nextScale;
    applyTransform();
  }

  // Fit the whole image into the canvas (never upscale) and centre it.
  function resetView() {
    const vw = viewport.offsetWidth;
    const vh = viewport.offsetHeight;
    const fit = vw > 0 && vh > 0 ? Math.min(1, wrap.clientWidth / vw, wrap.clientHeight / vh) : 1;
    zoomScale = fit;
    panX = (wrap.clientWidth - vw * fit) / 2;
    panY = (wrap.clientHeight - vh * fit) / 2;
    applyTransform();
  }

  function renderDraftPolygon() {
    svg.querySelectorAll('[data-draft]').forEach((el) => el.remove());

    if (currentPoints.length === 0) {
      refreshSelection();
      return;
    }

    const pointsAttr = currentPoints.map((p) => `${p.x},${p.y}`).join(' ');
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', pointsAttr);
    poly.setAttribute('data-draft', 'true');
    poly.setAttribute('class', 'map-editor-draft-polygon');
    svg.appendChild(poly);

    currentPoints.forEach((p, i) => {
      svg.appendChild(
        squareAt(p, DRAFT_POINT_PX, 'map-editor-draft-point', {
          'data-draft': 'true',
          'data-pz': 'draft',
          'data-pi': String(i)
        })
      );
    });
    refreshSelection();
  }

  function renderSavedZones() {
    svg.querySelectorAll('[data-zone]').forEach((el) => el.remove());

    zones.forEach((zone, index) => {
      const pointsAttr = zone.points.map((p) => `${p.x},${p.y}`).join(' ');
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', pointsAttr);
      poly.setAttribute('data-zone', String(index));
      poly.setAttribute('class', 'map-editor-saved-polygon');
      poly.style.setProperty('--zone-color', zone.color);
      svg.appendChild(poly);

      zone.points.forEach((p, i) => {
        const square = squareAt(p, SAVED_POINT_PX, 'map-editor-saved-point', {
          'data-zone': String(index),
          'data-pz': String(index),
          'data-pi': String(i)
        });
        square.style.setProperty('--zone-color', zone.color);
        svg.appendChild(square);
      });
    });
    refreshSelection();
  }

  function renderZonesList() {
    zonesList.innerHTML = '';

    zones.forEach((zone, index) => {
      const row = document.createElement('div');
      row.className = 'map-editor-zone-row';

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.placeholder = 'Заголовок';
      titleInput.value = zone.title;
      titleInput.addEventListener('input', () => {
        zone.title = titleInput.value;
        output.value = buildYaml(imagePath, zones);
      });

      const linkInput = document.createElement('input');
      linkInput.type = 'text';
      linkInput.placeholder = 'Ссылка (необязательно), например /posts/moi-post/';
      linkInput.value = zone.link;
      linkInput.addEventListener('input', () => {
        zone.link = linkInput.value;
        output.value = buildYaml(imagePath, zones);
      });

      const textInput = document.createElement('textarea');
      textInput.placeholder = 'Текст (если ссылка не задана)';
      textInput.rows = 2;
      textInput.value = zone.text;
      textInput.addEventListener('input', () => {
        zone.text = textInput.value;
        output.value = buildYaml(imagePath, zones);
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'Удалить зону';
      removeBtn.addEventListener('click', () => {
        zones.splice(index, 1);
        renderSavedZones();
        renderZonesList();
        output.value = buildYaml(imagePath, zones);
      });

      // colour swatch next to the name: shows which colour belongs to the zone
      // on the map and opens the picker to change it
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.className = 'map-editor-zone-color';
      colorInput.title = 'Цвет зоны';
      colorInput.setAttribute('aria-label', 'Цвет зоны');
      colorInput.value = HEX_COLOR.test(zone.color ?? '') ? zone.color : ZONE_COLORS[0];
      colorInput.addEventListener('input', () => {
        zone.color = colorInput.value;
        renderSavedZones();
        syncOutput();
      });

      const nameCell = document.createElement('div');
      nameCell.className = 'map-editor-zone-name';
      nameCell.append(colorInput, titleInput);

      row.append(nameCell, linkInput, textInput, removeBtn);
      zonesList.appendChild(row);
    });
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    imagePath = `/assets/img/posts/${file.name}`;
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = resetView; // size is only known once the image is decoded
      img.src = reader.result;
      img.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  // Mouse-wheel zoom, centered on the cursor.
  wrap.addEventListener(
    'wheel',
    (event) => {
      if (img.hidden) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(event.clientX, event.clientY, factor);
    },
    { passive: false }
  );

  // Right-mouse-button drag to pan; left button still places polygon points.
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let panOrigin = { x: 0, y: 0 };

  wrap.addEventListener('contextmenu', (event) => event.preventDefault());

  wrap.addEventListener('mousedown', (event) => {
    if (img.hidden) return;

    // Stop native drag/selection from starting regardless of which button
    // triggered it (left-click placing a point, right-click panning).
    event.preventDefault();

    if (event.button !== 2) return;
    isPanning = true;
    panStart = { x: event.clientX, y: event.clientY };
    panOrigin = { x: panX, y: panY };
    wrap.classList.add('is-panning');
  });

  window.addEventListener('mousemove', (event) => {
    if (!isPanning) return;
    panX = panOrigin.x + (event.clientX - panStart.x);
    panY = panOrigin.y + (event.clientY - panStart.y);
    applyTransform();
  });

  window.addEventListener('mouseup', (event) => {
    if (event.button !== 2 || !isPanning) return;
    isPanning = false;
    wrap.classList.remove('is-panning');
  });

  wrap.addEventListener('click', (event) => {
    if (suppressClick || event.target.closest?.('[data-pi]')) return;
    if (img.hidden || event.button !== 0 || !isInsideImage(event)) return;
    currentPoints.push(svgPointFromEvent(event));
    renderDraftPolygon();
    finishBtn.disabled = currentPoints.length < 3;
    undoBtn.disabled = currentPoints.length === 0;
    clearBtn.disabled = false;
  });

  // --- editing existing points: pick one up, drag it, add/remove points ---
  svg.addEventListener('mousedown', (event) => {
    const el = event.target.closest?.('[data-pi]');
    if (!el || event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    suppressClick = true; // re-rendering below would turn the click into a map click

    const zone = el.dataset.pz === 'draft' ? 'draft' : Number(el.dataset.pz);
    selected = { zone, index: Number(el.dataset.pi) };
    dragging = { zone, index: selected.index, moved: false };
    refreshSelection();
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;

    const pts = pointsOf(dragging.zone);
    if (!pts || !pts[dragging.index]) return;

    pts[dragging.index] = svgPointFromEvent(event);
    dragging.moved = true;
    if (dragging.zone === 'draft') renderDraftPolygon();
    else renderSavedZones();
  });

  window.addEventListener('mouseup', () => {
    if (dragging) {
      if (dragging.moved && dragging.zone !== 'draft') syncOutput();
      dragging = null;
    }
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  });

  function rerenderZone(zone) {
    if (zone === 'draft') {
      renderDraftPolygon();
      finishBtn.disabled = currentPoints.length < 3;
      undoBtn.disabled = currentPoints.length === 0;
    } else {
      renderSavedZones();
      syncOutput();
    }
  }

  // New point halfway between the selected one and the next one (the zone is a
  // closed loop, so the last point connects back to the first).
  addMidBtn?.addEventListener('click', () => {
    if (!selected) return;

    const pts = pointsOf(selected.zone);
    if (!pts || pts.length < 2) return;

    const a = pts[selected.index];
    const b = pts[(selected.index + 1) % pts.length];
    pts.splice(selected.index + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    selected = { zone: selected.zone, index: selected.index + 1 };
    rerenderZone(selected.zone);
  });

  function deleteSelectedPoint() {
    if (!selected) return;

    const pts = pointsOf(selected.zone);
    const minPoints = selected.zone === 'draft' ? 1 : MIN_ZONE_POINTS;
    if (!pts || pts.length <= minPoints) return;

    pts.splice(selected.index, 1);
    selected = { zone: selected.zone, index: Math.max(0, selected.index - 1) };
    rerenderZone(selected.zone);
  }

  delPointBtn?.addEventListener('click', deleteSelectedPoint);

  document.addEventListener('keydown', (event) => {
    if (event.target.closest?.('input, textarea')) return;
    if (!selected) return;

    if (event.key === 'Delete') {
      event.preventDefault();
      deleteSelectedPoint();
    } else if (event.key === 'Escape') {
      selected = null;
      refreshSelection();
    }
  });

  undoBtn.addEventListener('click', () => {
    currentPoints.pop();
    renderDraftPolygon();
    finishBtn.disabled = currentPoints.length < 3;
    undoBtn.disabled = currentPoints.length === 0;
  });

  clearBtn.addEventListener('click', () => {
    currentPoints = [];
    renderDraftPolygon();
    finishBtn.disabled = true;
    undoBtn.disabled = true;
  });

  finishBtn.addEventListener('click', () => {
    if (currentPoints.length < 3) return;

    zones.push({
      points: currentPoints,
      title: `Зона ${zones.length + 1}`,
      color: nextColor(),
      text: '',
      link: ''
    });

    currentPoints = [];
    renderDraftPolygon();
    renderSavedZones();
    renderZonesList();
    finishBtn.disabled = true;
    undoBtn.disabled = true;
    output.value = buildYaml(imagePath, zones);
  });

  // The "Код" field is editable: paste a finished map (or tweak the YAML by
  // hand) and the zones on the map and in the list follow. The field itself is
  // never rewritten while it is being typed in.
  let codeTimer = 0;
  output.addEventListener('input', () => {
    clearTimeout(codeTimer);
    codeTimer = setTimeout(() => {
      const parsed = parseMapYaml(output.value);
      // empty or unparseable text leaves the current zones alone
      if (output.value.trim() && parsed.zones.length === 0) return;

      zones.length = 0;
      zones.push(...parsed.zones);
      ensureColors();
      if (parsed.image) imagePath = parsed.image;
      currentPoints = [];

      renderDraftPolygon();
      renderSavedZones();
      renderZonesList();
      finishBtn.disabled = true;
      undoBtn.disabled = true;
      clearBtn.disabled = zones.length === 0;
    }, 300);
  });

  copyBtn.addEventListener('click', () => {
    if (!output.value) return;
    navigator.clipboard?.writeText(output.value);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMapEditor);
} else {
  initMapEditor();
}
