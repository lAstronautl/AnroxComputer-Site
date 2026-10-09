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

function init() {
  const fileInput = document.getElementById('map-editor-file');
  const img = document.getElementById('map-editor-img');
  const svg = document.getElementById('map-editor-svg');
  const wrap = img?.parentElement;
  const finishBtn = document.getElementById('map-editor-finish');
  const undoBtn = document.getElementById('map-editor-undo');
  const clearBtn = document.getElementById('map-editor-clear');
  const copyBtn = document.getElementById('map-editor-copy');
  const zonesList = document.getElementById('map-editor-zones');
  const output = document.getElementById('map-editor-output');

  if (!fileInput || !img || !svg || !wrap) return;

  let imagePath = '';
  let currentPoints = [];
  const zones = [];

  const NS = 'http://www.w3.org/2000/svg';

  function svgPointFromEvent(event) {
    const rect = wrap.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
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
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', p.x);
      dot.setAttribute('cy', p.y);
      dot.setAttribute('r', 1);
      dot.setAttribute('data-draft', 'true');
      dot.setAttribute('class', 'map-editor-draft-point');
      svg.appendChild(dot);
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
      img.src = reader.result;
      img.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  wrap.addEventListener('click', (event) => {
    if (img.hidden) return;
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

  copyBtn.addEventListener('click', () => {
    if (!output.value) return;
    navigator.clipboard?.writeText(output.value);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
