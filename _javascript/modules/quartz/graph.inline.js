import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  select,
  drag,
  zoom,
  zoomIdentity
} from 'd3';
import { Text, Graphics, Application, Container, Circle } from 'pixi.js';
import { Group as TweenGroup, Tween as Tweened } from '@tweenjs/tween.js';
import { registerEscapeHandler, removeAllChildren } from './util';
import { getFullSlug, resolveRelative, simplifySlug } from './path';

const localStorageKey = 'graph-visited';
function getVisited() {
  return new Set(JSON.parse(localStorage.getItem(localStorageKey) ?? '[]'));
}

function addToVisited(slug) {
  const visited = getVisited();
  visited.add(slug);
  localStorage.setItem(localStorageKey, JSON.stringify([...visited]));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function measureLayoutSize(graph) {
  const rect = graph.getBoundingClientRect();
  const width = graph.clientWidth || graph.offsetWidth || rect.width || graph.parentElement?.clientWidth || 0;
  const height = graph.clientHeight || graph.offsetHeight || rect.height || graph.parentElement?.clientHeight || 0;
  return { width, height };
}

async function waitForLayoutSize(graph) {
  const initial = measureLayoutSize(graph);
  if (initial.width > 0 && initial.height > 0) {
    return initial;
  }

  if (typeof ResizeObserver === 'undefined') {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = measureLayoutSize(graph);
      if (next.width > 0 && next.height > 0) return next;
      await nextFrame();
    }

    return {
      width: Math.max(measureLayoutSize(graph).width, 1),
      height: Math.max(measureLayoutSize(graph).height, 250)
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let observer = null;

    const finish = (size) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      resolve(size);
    };

    const check = () => {
      if (!graph.isConnected) {
        finish({
          width: Math.max(measureLayoutSize(graph).width, 1),
          height: Math.max(measureLayoutSize(graph).height, 250)
        });
        return;
      }

      const size = measureLayoutSize(graph);
      if (size.width > 0 && size.height > 0) {
        finish(size);
      }
    };

    observer = new ResizeObserver(() => check());
    observer.observe(graph);
    if (graph.parentElement) observer.observe(graph.parentElement);
    nextFrame().then(check);
  });
}

async function renderGraph(graph, fullSlug) {
  const slug = simplifySlug(fullSlug);
  const visited = getVisited();
  removeAllChildren(graph);

  const {
    drag: enableDrag,
    zoom: enableZoom,
    depth,
    scale,
    repelForce,
    centerForce,
    linkDistance,
    fontSize,
    opacityScale,
    removeTags,
    showTags,
    hideGraphTag,
    focusOnHover,
    enableRadial
  } = JSON.parse(graph.dataset.cfg);

  const fetchData = globalThis.fetchData;
  if (!fetchData) return () => {};

  const data = new Map(
    Object.entries(await fetchData).map(([k, v]) => [simplifySlug(k), v])
  );

  const links = [];
  const tags = [];
  const validLinks = new Set(data.keys());

  const tweens = new Map();
  for (const [source, details] of data.entries()) {
    const outgoing = details.links ?? [];

    for (const dest of outgoing) {
      if (validLinks.has(dest)) {
        links.push({ source, target: dest });
      }
    }

    if (showTags) {
      const localTags = (details.tags ?? [])
        .filter((tag) => !removeTags.includes(tag))
        .filter((tag) => (hideGraphTag ? tag !== 'graph' : true))
        .map((tag) => simplifySlug(`tags/${tag}`));

      tags.push(...localTags.filter((tag) => !tags.includes(tag)));

      for (const tag of localTags) {
        links.push({ source, target: tag });
      }
    }
  }

  const neighbourhood = new Set();
  const wl = [slug, '__SENTINEL'];
  if (depth >= 0) {
    let d = depth;
    while (d >= 0 && wl.length > 0) {
      const cur = wl.shift();
      if (cur === '__SENTINEL') {
        d--;
        wl.push('__SENTINEL');
      } else {
        neighbourhood.add(cur);
        const outgoing = links.filter((l) => l.source === cur);
        const incoming = links.filter((l) => l.target === cur);
        wl.push(...outgoing.map((l) => l.target), ...incoming.map((l) => l.source));
      }
    }
  } else {
    validLinks.forEach((id) => neighbourhood.add(id));
    if (showTags) tags.forEach((tag) => neighbourhood.add(tag));
  }

  const nodes = [...neighbourhood].map((url) => {
    const text = url.startsWith('tags/') ? `#${url.substring(5)}` : (data.get(url)?.title ?? url);
    return {
      id: url,
      text,
      tags: data.get(url)?.tags ?? []
    };
  });

  const graphData = {
    nodes,
    links: links
      .filter((l) => neighbourhood.has(l.source) && neighbourhood.has(l.target))
      .map((l) => ({
        source: nodes.find((n) => n.id === l.source),
        target: nodes.find((n) => n.id === l.target)
      }))
  };

  const { width, height } = await waitForLayoutSize(graph);

  const simulation = forceSimulation(graphData.nodes)
    .force('charge', forceManyBody().strength(-100 * repelForce))
    .force('center', forceCenter().strength(centerForce))
    .force('link', forceLink(graphData.links).distance(linkDistance))
    .force('collide', forceCollide((n) => nodeRadius(n)).iterations(3));

  const radius = (Math.min(width, height) / 2) * 0.8;
  if (enableRadial) simulation.force('radial', forceRadial(radius).strength(0.2));

  function resolveCssColor(value, fallback) {
    const raw = (value ?? '').toString().trim();
    if (!raw.length) return fallback;

    // Pixi can't parse CSS var() or unresolved custom-property values.
    // Resolve via computed style on a temporary element.
    if (raw.includes('var(')) {
      const el = document.createElement('span');
      el.style.position = 'absolute';
      el.style.left = '-99999px';
      el.style.top = '-99999px';
      el.style.color = raw;
      document.body.appendChild(el);
      const resolved = getComputedStyle(el).color?.toString().trim();
      el.remove();
      return resolved && resolved.length ? resolved : fallback;
    }

    return raw;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name);
  }

  // Graph colors are controlled by theme variables in `_sass/themes`.
  const computedStyleMap = {
    '--graph-node-current': resolveCssColor(cssVar('--graph-node-current'), resolveCssColor(cssVar('--link-color'), '#0d6efd')),
    '--graph-node-visited': resolveCssColor(cssVar('--graph-node-visited'), '#6c757d'),
    '--graph-node-default': resolveCssColor(cssVar('--graph-node-default'), '#6c757d'),
    '--graph-node-tag': resolveCssColor(cssVar('--graph-node-tag'), '#c2c6cc'),
    '--graph-link-color': resolveCssColor(cssVar('--graph-link-color'), 'rgba(0,0,0,0.18)'),
    '--graph-link-active-color': resolveCssColor(cssVar('--graph-link-active-color'), '#6c757d'),
    '--graph-label-color': resolveCssColor(cssVar('--graph-label-color'), resolveCssColor(cssVar('--text-color'), '#2b2d31')),
    '--bodyFont': (cssVar('--bodyFont') ?? '').toString().trim() || 'system-ui'
  };

  const color = (d) => {
    const isCurrent = d.id === slug;
    if (isCurrent) return computedStyleMap['--graph-node-current'];
    if (d.id.startsWith('tags/')) return computedStyleMap['--graph-node-tag'];
    const isVisited = visited.has(d.id);
    return isVisited ? computedStyleMap['--graph-node-visited'] : computedStyleMap['--graph-node-default'];
  };

  function nodeRadius(d) {
    const base = d.id.startsWith('tags/') ? 6 : 7;
    return base;
  }

  const app = new Application();
  await app.init({
    width: Math.max(width, 1),
    height,
    antialias: true,
    autoStart: false,
    autoDensity: true,
    backgroundAlpha: 0,
    resizeTo: graph,
    preference: 'webgpu',
    resolution: window.devicePixelRatio,
    eventMode: 'static'
  });
  graph.appendChild(app.canvas);

  const stage = app.stage;
  // Pixi v8: events are controlled via `eventMode`. If stage is not enabled for
  // events, node clicks won't fire.
  stage.eventMode = 'static';

  const labelsContainer = new Container({ zIndex: 3, isRenderGroup: true });
  const nodesContainer = new Container({ zIndex: 2, isRenderGroup: true });
  const linkContainer = new Container({ zIndex: 1, isRenderGroup: true });
  stage.addChild(nodesContainer, labelsContainer, linkContainer);

  const nodeRenderData = [];
  for (const n of graphData.nodes) {
    const nodeId = n.id;

    const label = new Text({
      interactive: false,
      eventMode: 'none',
      text: n.text,
      alpha: 0,
      anchor: { x: 0.5, y: 1.2 },
      style: {
        fontSize: fontSize * 15,
        fill: computedStyleMap['--graph-label-color'],
        fontFamily: computedStyleMap['--bodyFont']
      },
      resolution: window.devicePixelRatio * 4
    });
    label.scale.set(1 / scale);

    let oldLabelOpacity = 0;
    const isTagNode = nodeId.startsWith('tags/');
    const gfx = new Graphics({
      interactive: true,
      label: nodeId,
      eventMode: 'static',
      hitArea: new Circle(0, 0, nodeRadius(n)),
      cursor: 'pointer'
    });

    gfx.circle(0, 0, nodeRadius(n)).fill(color(n));

    nodesContainer.addChild(gfx);
    labelsContainer.addChild(label);

    const renderData = {
      gfx,
      color: color(n),
      alpha: 1,
      active: false,
      simulationData: n,
      label
    };
    nodeRenderData.push(renderData);

    gfx.on('mouseenter', () => {
      oldLabelOpacity = label.alpha;
      label.alpha = 1;
    });
    gfx.on('mouseleave', () => {
      label.alpha = oldLabelOpacity;
    });
  }

  const linkRenderData = [];
  for (const l of graphData.links) {
    const gfx = new Graphics({ interactive: false, eventMode: 'none' });
    linkContainer.addChild(gfx);
    linkRenderData.push({
      gfx,
      color: computedStyleMap['--graph-link-color'],
      alpha: 1,
      active: false,
      simulationData: l
    });
  }

  let currentTransform = zoomIdentity;
  stage.scale.set(1, 1);
  stage.position.set(0, 0);

  let hoveredNodeId = null;
  let hoveredNeighbours = new Set();

  function setHoverInfo(newHoveredId) {
    hoveredNodeId = newHoveredId;

    if (newHoveredId === null) {
      hoveredNeighbours = new Set();
      for (const n of nodeRenderData) n.active = false;
      for (const l of linkRenderData) l.active = false;
    } else {
      hoveredNeighbours = new Set();
      for (const l of linkRenderData) {
        const linkData = l.simulationData;
        if (linkData.source.id === newHoveredId || linkData.target.id === newHoveredId) {
          hoveredNeighbours.add(linkData.source.id);
          hoveredNeighbours.add(linkData.target.id);
        }
        l.active = linkData.source.id === newHoveredId || linkData.target.id === newHoveredId;
      }
      for (const n of nodeRenderData) {
        n.active = hoveredNeighbours.has(n.simulationData.id);
      }
    }
  }

  let dragStartTime = 0;
  let dragging = false;

  function renderLinks() {
    tweens.get('link')?.stop();
    const tweenGroup = new TweenGroup();

    for (const l of linkRenderData) {
      let alpha = 1;
      if (hoveredNodeId) alpha = l.active ? 1 : 0.2;

      l.color = l.active ? computedStyleMap['--graph-link-active-color'] : computedStyleMap['--graph-link-color'];
      tweenGroup.add(new Tweened(l).to({ alpha }, 200));
    }

    tweenGroup.getAll().forEach((tw) => tw.start());
    tweens.set('link', {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop());
      }
    });
  }

  function renderLabels() {
    tweens.get('label')?.stop();
    const tweenGroup = new TweenGroup();

    const defaultScale = 1 / scale;
    const activeScale = defaultScale * 1.1;
    for (const n of nodeRenderData) {
      const nodeId = n.simulationData.id;
      if (hoveredNodeId === nodeId) {
        tweenGroup.add(
          new Tweened(n.label).to(
            { alpha: 1, scale: { x: activeScale, y: activeScale } },
            100
          )
        );
      } else {
        tweenGroup.add(
          new Tweened(n.label).to(
            { alpha: n.label.alpha, scale: { x: defaultScale, y: defaultScale } },
            100
          )
        );
      }
    }

    tweenGroup.getAll().forEach((tw) => tw.start());
    tweens.set('label', {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop());
      }
    });
  }

  function renderNodes() {
    tweens.get('hover')?.stop();

    const tweenGroup = new TweenGroup();
    for (const n of nodeRenderData) {
      let alpha = 1;
      if (hoveredNodeId !== null && focusOnHover) alpha = n.active ? 1 : 0.2;
      tweenGroup.add(new Tweened(n.gfx, tweenGroup).to({ alpha }, 200));
    }

    tweenGroup.getAll().forEach((tw) => tw.start());
    tweens.set('hover', {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop());
      }
    });
  }

  function renderPixiFromD3() {
    renderNodes();
    renderLinks();
    renderLabels();
  }

  tweens.forEach((tween) => tween.stop());
  tweens.clear();

  function ticked() {
    renderPixiFromD3();
  }

  simulation.on('tick', ticked);

  // hover info (used by drag.subject)
  for (const node of nodeRenderData) {
    node.gfx.on('mouseenter', () => setHoverInfo(node.simulationData.id));
    node.gfx.on('mouseleave', () => setHoverInfo(null));
  }

  // interactions (match Quartz behaviour)
  if (enableDrag) {
    select(app.canvas).call(
      drag()
        .container(() => app.canvas)
        .subject(() => graphData.nodes.find((n) => n.id === hoveredNodeId))
        .on('start', (event) => {
          if (!event.active) simulation.alphaTarget(1).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
          event.subject.__initialDragPos = {
            x: event.subject.x,
            y: event.subject.y,
            fx: event.subject.fx,
            fy: event.subject.fy
          };
          dragStartTime = Date.now();
          dragging = true;
        })
        .on('drag', (event) => {
          const initPos = event.subject.__initialDragPos;
          event.subject.fx = initPos.x + (event.x - initPos.x) / currentTransform.k;
          event.subject.fy = initPos.y + (event.y - initPos.y) / currentTransform.k;
        })
        .on('end', (event) => {
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
          dragging = false;

          // click (short drag)
          if (Date.now() - dragStartTime < 500) {
            const node = graphData.nodes.find((n) => n.id === event.subject.id);
            if (node) {
              const targ = resolveRelative(fullSlug, node.id);
              window.spaNavigate(new URL(targ, window.location.toString()));
            }
          }
        })
    );
  } else {
    for (const node of nodeRenderData) {
      node.gfx.on('click', () => {
        const targ = resolveRelative(fullSlug, node.simulationData.id);
        window.spaNavigate(new URL(targ, window.location.toString()));
      });
    }
  }

  if (enableZoom) {
    select(app.canvas).call(
      zoom()
        .extent([
          [0, 0],
          [width, height]
        ])
        .scaleExtent([0.25, 4])
        .on('zoom', ({ transform }) => {
          currentTransform = transform;
          stage.scale.set(transform.k, transform.k);
          stage.position.set(transform.x, transform.y);

          // zoom adjusts opacity of labels too
          const sc = transform.k * opacityScale;
          const scaleOpacity = Math.max((sc - 1) / 3.75, 0);
          const activeNodes = nodeRenderData.filter((n) => n.active).flatMap((n) => n.label);

          for (const label of labelsContainer.children) {
            if (!activeNodes.includes(label)) {
              label.alpha = scaleOpacity;
            }
          }
        })
    );
  }

  let stopAnimation = false;
  function animate(time) {
    if (stopAnimation) return;

    for (const n of nodeRenderData) {
      const { x, y } = n.simulationData;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n.gfx.position.set(x + width / 2, y + height / 2);
      if (n.label) n.label.position.set(x + width / 2, y + height / 2);
    }

    for (const l of linkRenderData) {
      const linkData = l.simulationData;
      if (
        !Number.isFinite(linkData.source?.x) ||
        !Number.isFinite(linkData.source?.y) ||
        !Number.isFinite(linkData.target?.x) ||
        !Number.isFinite(linkData.target?.y)
      ) {
        continue;
      }
      l.gfx.clear();
      l.gfx.moveTo(linkData.source.x + width / 2, linkData.source.y + height / 2);
      l.gfx
        .lineTo(linkData.target.x + width / 2, linkData.target.y + height / 2)
        .stroke({ alpha: l.alpha, width: 1, color: l.color });
    }

    tweens.forEach((t) => t.update(time));
    app.renderer.render(stage);
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
  return () => {
    stopAnimation = true;
    app.destroy();
  };
}

let localGraphCleanups = [];
let globalGraphCleanups = [];

function cleanupLocalGraphs() {
  for (const cleanup of localGraphCleanups) cleanup();
  localGraphCleanups = [];
}

function cleanupGlobalGraphs() {
  for (const cleanup of globalGraphCleanups) cleanup();
  globalGraphCleanups = [];
}

document.addEventListener('nav', async (e) => {
  const slug = e.detail.url;
  addToVisited(simplifySlug(slug));

  async function renderLocalGraph() {
    cleanupLocalGraphs();
    const localGraphContainers = document.getElementsByClassName('graph-container');
    for (const container of localGraphContainers) {
      localGraphCleanups.push(await renderGraph(container, slug));
    }
  }

  await renderLocalGraph();
  const handleThemeChange = () => {
    void renderLocalGraph();
  };

  document.addEventListener('themechange', handleThemeChange);
  window.addCleanup(() => {
    document.removeEventListener('themechange', handleThemeChange);
  });

  const containers = [...document.getElementsByClassName('global-graph-outer')];
  async function renderGlobalGraph() {
    const currentSlug = getFullSlug(window);
    for (const container of containers) {
      container.classList.add('active');
      const graphContainer = container.querySelector('.global-graph-container');
      registerEscapeHandler(container, hideGlobalGraph);
      if (graphContainer) {
        globalGraphCleanups.push(await renderGraph(graphContainer, currentSlug));
      }
    }
  }

  function hideGlobalGraph() {
    cleanupGlobalGraphs();
    for (const container of containers) {
      container.classList.remove('active');
    }
  }

  async function shortcutHandler(e) {
    if (e.key === 'g' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      const anyGlobalGraphOpen = containers.some((container) => container.classList.contains('active'));
      anyGlobalGraphOpen ? hideGlobalGraph() : renderGlobalGraph();
    }
  }

  const containerIcons = document.getElementsByClassName('global-graph-icon');
  Array.from(containerIcons).forEach((icon) => {
    icon.addEventListener('click', renderGlobalGraph);
    window.addCleanup(() => icon.removeEventListener('click', renderGlobalGraph));
  });

  document.addEventListener('keydown', shortcutHandler);
  window.addCleanup(() => {
    document.removeEventListener('keydown', shortcutHandler);
    cleanupLocalGraphs();
    cleanupGlobalGraphs();
  });
});
