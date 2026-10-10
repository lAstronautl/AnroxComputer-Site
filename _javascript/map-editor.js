/**
 * Standalone visual editor for building interactive-map zone data.
 * Load an image, click points to build a polygon zone, fill in its
 * metadata, repeat, then copy the generated YAML into a post's front
 * matter under `interactive_map:`.
 */

function escapeYaml(value) {
  return String(value ?? '').replace(/"/g, '\\"');
}

function buildYaml(imagePath, zones) {
  if (zones.length === 0) return '';

  const lines = ['interactive_map:', `  image: ${imagePath || '/assets/img/posts/your-map.png'}`, '  zones:'];

  for (const zone of zones) {
    const points = zone.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    lines.push(`    - points: "${points}"`);
    lines.push(`      title: "${escapeYaml(zone.title)}"`);
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
      current = { points: [], title: '', text: '', link: '' };
      zones.push(current);
      line = line.slice(2).trim();
    }

    const match = line.match(/^(image|points|title|text|link):\s*(.*)$/);
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

    if (currentPoints.length === 0) return;

    const pointsAttr = currentPoints.map((p) => `${p.x},${p.y}`).join(' ');
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', pointsAttr);
    poly.setAttribute('data-draft', 'true');
    poly.setAttribute('class', 'map-editor-draft-polygon');
    svg.appendChild(poly);

    currentPoints.forEach((p) => {
      svg.appendChild(squareAt(p, DRAFT_POINT_PX, 'map-editor-draft-point', { 'data-draft': 'true' }));
    });
  }

  function renderSavedZones() {
    svg.querySelectorAll('[data-zone]').forEach((el) => el.remove());

    zones.forEach((zone, index) => {
      const pointsAttr = zone.points.map((p) => `${p.x},${p.y}`).join(' ');
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', pointsAttr);
      poly.setAttribute('data-zone', String(index));
      poly.setAttribute('class', 'map-editor-saved-polygon');
      svg.appendChild(poly);

      zone.points.forEach((p) => {
        svg.appendChild(squareAt(p, SAVED_POINT_PX, 'map-editor-saved-point', { 'data-zone': String(index) }));
      });
    });
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

      row.append(titleInput, linkInput, textInput, removeBtn);
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
    if (img.hidden || event.button !== 0 || !isInsideImage(event)) return;
    currentPoints.push(svgPointFromEvent(event));
    renderDraftPolygon();
    finishBtn.disabled = currentPoints.length < 3;
    undoBtn.disabled = currentPoints.length === 0;
    clearBtn.disabled = false;
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
