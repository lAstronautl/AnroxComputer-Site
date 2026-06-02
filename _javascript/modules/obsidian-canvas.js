const SIDE_ANCHORS = {
  top: [0.5, 0],
  right: [1, 0.5],
  bottom: [0.5, 1],
  left: [0, 0.5]
};

const COLORS = {
  1: ['#ffe2e2', '#c34242'],
  2: ['#e4f0ff', '#3d6fb6'],
  3: ['#fff3c7', '#ad7b00'],
  4: ['#e6f6e6', '#438447'],
  5: ['#f0e5ff', '#7b54c6'],
  6: ['#fde7f3', '#b84b83']
};

function parseData(viewer) {
  const script = viewer.querySelector('.obsidian-canvas-data');
  if (!script) return null;

  try {
    return JSON.parse(script.textContent);
  } catch (error) {
    console.error('Failed to parse Obsidian canvas data', error);
    return null;
  }
}

function worldBounds(nodes) {
  if (!nodes.length) {
    return { minX: 0, minY: 0, maxX: 800, maxY: 500, width: 800, height: 500 };
  }

  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function layoutNode(node, bounds, padding) {
  return {
    ...node,
    x: node.x - bounds.minX + padding,
    y: node.y - bounds.minY + padding
  };
}

function anchor(node, side) {
  const pair = SIDE_ANCHORS[side] || [0.5, 0.5];
  return {
    x: node.x + node.width * pair[0],
    y: node.y + node.height * pair[1]
  };
}

function imageUrl(baseurl, file) {
  if (!file) return '';
  if (/^https?:\/\//i.test(file)) return file;

  const base = (baseurl || '').replace(/\/+$/, '');
  const path = file.replace(/^\/+/, '');
  return encodeURI(`${base}/${path}`);
}

function renderNode(node, baseurl) {
  const el = document.createElement('div');
  el.className = `obsidian-canvas-node obsidian-canvas-node--${node.type || 'text'}`;
  el.dataset.nodeId = node.id;
  el.style.left = `${node.x}px`;
  el.style.top = `${node.y}px`;
  el.style.width = `${node.width}px`;
  el.style.height = `${node.height}px`;

  const color = COLORS[node.color];
  if (color) {
    el.style.setProperty('--canvas-node-bg', color[0]);
    el.style.setProperty('--canvas-node-accent', color[1]);
  }

  if (node.type === 'file') {
    const img = document.createElement('img');
    img.alt = node.file || '';
    img.src = imageUrl(baseurl, node.file);
    img.addEventListener('error', () => {
      el.classList.add('is-missing-file');
      img.remove();
      el.textContent = node.file?.split(/[\\/]/).pop() || 'file';
    }, { once: true });
    el.appendChild(img);
    el.title = node.file || '';
    return el;
  }

  el.textContent = node.text || '';
  return el;
}

function pathForEdge(edge, nodeById) {
  const from = nodeById.get(edge.fromNode);
  const to = nodeById.get(edge.toNode);
  if (!from || !to) return '';

  const start = anchor(from, edge.fromSide);
  const end = anchor(to, edge.toSide);
  const dx = Math.max(40, Math.abs(end.x - start.x) * 0.35);
  const dy = Math.max(40, Math.abs(end.y - start.y) * 0.35);
  const c1 = { x: start.x, y: start.y };
  const c2 = { x: end.x, y: end.y };

  if (edge.fromSide === 'left') c1.x -= dx;
  if (edge.fromSide === 'right') c1.x += dx;
  if (edge.fromSide === 'top') c1.y -= dy;
  if (edge.fromSide === 'bottom') c1.y += dy;
  if (edge.toSide === 'left') c2.x -= dx;
  if (edge.toSide === 'right') c2.x += dx;
  if (edge.toSide === 'top') c2.y -= dy;
  if (edge.toSide === 'bottom') c2.y += dy;

  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}

function applyTransform(stage, state) {
  stage.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
}

function initViewer(viewer) {
  if (viewer.dataset.canvasReady === 'true') return;
  viewer.dataset.canvasReady = 'true';

  const data = parseData(viewer);
  if (!data) return;

  const stage = viewer.querySelector('.obsidian-canvas-stage');
  const svg = viewer.querySelector('.obsidian-canvas-edges');
  const nodesEl = viewer.querySelector('.obsidian-canvas-nodes');
  const baseurl = viewer.dataset.baseurl || '';
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  const bounds = worldBounds(nodes);
  const padding = 180;
  const stageWidth = bounds.width + padding * 2;
  const stageHeight = bounds.height + padding * 2;
  const layoutNodes = nodes.map((node) => layoutNode(node, bounds, padding));
  const nodeById = new Map(layoutNodes.map((node) => [node.id, node]));
  const state = { x: 0, y: 0, scale: 1 };

  stage.style.width = `${stageWidth}px`;
  stage.style.height = `${stageHeight}px`;
  stage.style.transformOrigin = '0 0';
  svg.setAttribute('viewBox', `0 0 ${stageWidth} ${stageHeight}`);
  svg.innerHTML = '';
  nodesEl.innerHTML = '';

  edges.forEach((edge) => {
    const path = pathForEdge(edge, nodeById);
    if (!path) return;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', path);
    line.setAttribute('class', 'obsidian-canvas-edge');
    svg.appendChild(line);
  });

  layoutNodes.forEach((node) => nodesEl.appendChild(renderNode(node, baseurl)));

  function fit() {
    const rect = viewer.getBoundingClientRect();
    const toolbarHeight = 0;
    const scale = Math.min(
      1.2,
      Math.max(0.15, Math.min((rect.width - 32) / stageWidth, (rect.height - toolbarHeight - 32) / stageHeight))
    );
    state.scale = scale;
    state.x = (rect.width - stageWidth * scale) / 2;
    state.y = (rect.height - stageHeight * scale) / 2;
    applyTransform(stage, state);
  }

  fit();

  let dragging = false;
  let dragStart = null;

  viewer.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.obsidian-canvas-toolbar')) return;
    dragging = true;
    dragStart = { clientX: event.clientX, clientY: event.clientY, x: state.x, y: state.y };
    viewer.setPointerCapture(event.pointerId);
  });

  viewer.addEventListener('pointermove', (event) => {
    if (!dragging || !dragStart) return;
    state.x = dragStart.x + event.clientX - dragStart.clientX;
    state.y = dragStart.y + event.clientY - dragStart.clientY;
    applyTransform(stage, state);
  });

  viewer.addEventListener('pointerup', (event) => {
    dragging = false;
    dragStart = null;
    try {
      viewer.releasePointerCapture(event.pointerId);
    } catch {
      // ignore release errors from cancelled pointers
    }
  });

  viewer.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = viewer.getBoundingClientRect();
    const oldScale = state.scale;
    const nextScale = Math.min(3, Math.max(0.1, oldScale * (event.deltaY > 0 ? 0.9 : 1.1)));
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const worldX = (pointerX - state.x) / oldScale;
    const worldY = (pointerY - state.y) / oldScale;

    state.scale = nextScale;
    state.x = pointerX - worldX * nextScale;
    state.y = pointerY - worldY * nextScale;
    applyTransform(stage, state);
  }, { passive: false });

  viewer.querySelector('[data-canvas-action="zoom-out"]')?.addEventListener('click', () => {
    state.scale = Math.max(0.1, state.scale * 0.85);
    applyTransform(stage, state);
  });

  viewer.querySelector('[data-canvas-action="zoom-in"]')?.addEventListener('click', () => {
    state.scale = Math.min(3, state.scale * 1.15);
    applyTransform(stage, state);
  });

  viewer.querySelector('[data-canvas-action="reset"]')?.addEventListener('click', fit);
  window.addEventListener('resize', fit);
}

export function initObsidianCanvas() {
  document.querySelectorAll('.obsidian-canvas').forEach(initViewer);
}
