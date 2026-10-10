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
  zoomIdentity,
  easeCubicOut
} from 'd3';
import { Text, Graphics, Application, Container, Circle } from 'pixi.js';
import { Group as TweenGroup, Tween as Tweened, Easing } from '@tweenjs/tween.js';
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

  for (const n of graphData.nodes) n.degree = 0;
  for (const l of graphData.links) {
    l.source.degree += 1;
    l.target.degree += 1;
  }

  const initialSize = await waitForLayoutSize(graph);
  // Current container size. Updated by the ResizeObserver below; every consumer
  // (centering, radial force, zoom extent) must read these, never a copy.
  let width = initialSize.width;
  let height = initialSize.height;

  // The simulation lives in screen (container) coordinates: its centre is the
  // centre of the container, so `animate()` can draw positions as they are.
  const radialRadius = () => (Math.min(width, height) / 2) * 0.8;

  const simulation = forceSimulation(graphData.nodes)
    .force('charge', forceManyBody().strength(-100 * repelForce))
    .force('center', forceCenter(width / 2, height / 2).strength(centerForce))
    .force('link', forceLink(graphData.links).distance(linkDistance))
    .force('collide', forceCollide((n) => nodeRadius(n) + 2).iterations(3))
    // slower cooling + a bit more friction: nodes drift into place and settle
    // gently instead of snapping, like the Obsidian graph
    .alphaDecay(0.015)
    .velocityDecay(0.35);

  if (enableRadial) {
    simulation.force('radial', forceRadial(radialRadius(), width / 2, height / 2).strength(0.2));
  }

  // d3 seeds new nodes around (0, 0); move them to the container centre so the
  // layout does not have to fly in from the corner.
  for (const n of graphData.nodes) {
    n.x += width / 2;
    n.y += height / 2;
  }

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

  // Like Obsidian: the more connections a note has, the bigger its node.
  function nodeRadius(d) {
    const base = d.id.startsWith('tags/') ? 4 : 5;
    return Math.min(base + Math.sqrt(d.degree ?? 0) * 1.6, 14);
  }

  const app = new Application();
  await app.init({
    width: Math.max(width, 1),
    height,
    antialias: true,
    autoStart: false,
    autoDensity: true,
    backgroundAlpha: 0,
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
      // Labels are drawn at a constant on-screen size (see zoom handler), so a
      // modest supersampling factor is enough; x4 only burned GPU memory.
      resolution: Math.min(window.devicePixelRatio * 2, 4)
    });
    label.scale.set(1 / scale);

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

  // set whenever the picture must be redrawn although nothing is animating
  let viewDirty = true;

  // Label opacity driven by zoom level (labels fade in when zooming in).
  let labelBaseAlpha = 0;

  // Click-vs-drag detection: distance travelled in screen px between start/end.
  const CLICK_DISTANCE_PX = 5;
  let dragStart = null;

  // Visual hover state (alpha / scale) is animated by tweens that are created
  // only when the state really changes (hover enter/leave), never per tick.
  function runTweens(key, build) {
    tweens.get(key)?.stop();
    const group = new TweenGroup();
    build(group);
    const all = group.getAll();
    all.forEach((tw) => tw.start());
    tweens.set(key, {
      update: (time) => group.update(time),
      active: () => all.some((tw) => tw.isPlaying()),
      stop: () => all.forEach((tw) => tw.stop())
    });
    viewDirty = true;
  }

  function renderLinks() {
    runTweens('link', (group) => {
      for (const l of linkRenderData) {
        let alpha = 1;
        if (hoveredNodeId) alpha = l.active ? 1 : 0.2;

        l.color = l.active ? computedStyleMap['--graph-link-active-color'] : computedStyleMap['--graph-link-color'];
        group.add(new Tweened(l).to({ alpha }, 200).easing(Easing.Quadratic.Out));
      }
    });
  }

  function labelScales() {
    const defaultScale = (1 / scale) * (1 / currentTransform.k);
    return { defaultScale, activeScale: defaultScale * 1.1 };
  }

  function renderLabels() {
    const { defaultScale, activeScale } = labelScales();
    runTweens('label', (group) => {
      for (const n of nodeRenderData) {
        const isHovered = hoveredNodeId === n.simulationData.id;
        const target = isHovered ? activeScale : defaultScale;
        // the hovered note and its neighbours get readable labels
        const alpha = isHovered ? 1 : n.active ? Math.max(labelBaseAlpha, 0.75) : labelBaseAlpha;
        group.add(
          new Tweened(n.label)
            .to({ alpha, scale: { x: target, y: target } }, 150)
            .easing(Easing.Quadratic.Out)
        );
      }
    });
  }

  function renderNodes() {
    runTweens('hover', (group) => {
      for (const n of nodeRenderData) {
        let alpha = 1;
        if (hoveredNodeId !== null && focusOnHover) alpha = n.active ? 1 : 0.2;
        const grow = hoveredNodeId === n.simulationData.id ? 1.3 : 1;
        group.add(
          new Tweened(n.gfx).to({ alpha, scale: { x: grow, y: grow } }, 200).easing(Easing.Quadratic.Out)
        );
      }
    });
  }

  function renderPixiFromD3() {
    renderNodes();
    renderLinks();
    renderLabels();
  }

  function setHoverInfo(newHoveredId) {
    if (newHoveredId === hoveredNodeId) return;
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

    renderPixiFromD3();
  }

  // hover info (used by drag.subject) — the single source of truth for hover
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
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
          event.subject.__initialDragPos = {
            x: event.subject.x,
            y: event.subject.y,
            fx: event.subject.fx,
            fy: event.subject.fy
          };
          // d3-drag reports event.x/y as subject position + pointer delta, so
          // the distance between start and end is the pointer travel in px.
          dragStart = { x: event.x, y: event.y };
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

          // click = the pointer barely moved, however long it was held
          const travelled = dragStart ? Math.hypot(event.x - dragStart.x, event.y - dragStart.y) : Infinity;
          dragStart = null;
          if (travelled < CLICK_DISTANCE_PX) {
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

  let removeWheel = () => {};
  const zoomBehavior = zoom()
    .extent([
      [0, 0],
      [width, height]
    ])
    .scaleExtent([0.25, 4])
    // wheel is handled below (smoothed, zooms towards the cursor)
    .filter((event) => event.type !== 'wheel' && !event.ctrlKey && event.button === 0 || event.type === 'touchstart')
    .on('zoom', ({ transform }) => {
      viewDirty = true;
      currentTransform = transform;
      stage.scale.set(transform.k, transform.k);
      stage.position.set(transform.x, transform.y);

      // zoom adjusts opacity of labels too
      const sc = transform.k * opacityScale;
      labelBaseAlpha = Math.max((sc - 1) / 3.75, 0);

      // Keep label text a stable on-screen size: counteract the stage scale so
      // the rasterized text isn't down/up-scaled and blurred. Applied directly
      // (not tweened) so it tracks the wheel without lag; a running label tween
      // would overwrite it with stale targets, so stop it first.
      tweens.get('label')?.stop();
      const { defaultScale, activeScale } = labelScales();
      for (const n of nodeRenderData) {
        const isHovered = hoveredNodeId === n.simulationData.id;
        const s = isHovered ? activeScale : defaultScale;
        n.label.scale.set(s);
        n.label.alpha = isHovered ? 1 : labelBaseAlpha;
      }
    });

  if (enableZoom) {
    const canvasSel = select(app.canvas);
    canvasSel.call(zoomBehavior).on('dblclick.zoom', null);

    // Obsidian-style wheel zoom: exponential steps, eased, anchored under the
    // cursor. Each wheel tick retargets the running transition from where it
    // currently is, so fast scrolling stays continuous.
    const onWheel = (event) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.0018));
      const k = Math.min(4, Math.max(0.25, currentTransform.k * factor));
      const rect = app.canvas.getBoundingClientRect();
      const point = [event.clientX - rect.left, event.clientY - rect.top];
      canvasSel.transition().duration(160).ease(easeCubicOut).call(zoomBehavior.scaleTo, k, point);
    };
    app.canvas.addEventListener('wheel', onWheel, { passive: false });
    removeWheel = () => app.canvas.removeEventListener('wheel', onWheel);
  }

  // Live reflow when the container changes size (window resize, sidebar
  // collapse, orientation change): keep the layout, just move its centre.
  let resizeFrame = 0;
  function applyResize() {
    resizeFrame = 0;
    const size = measureLayoutSize(graph);
    if (size.width <= 0 || size.height <= 0) return;
    if (size.width === width && size.height === height) return;

    const dx = (size.width - width) / 2;
    const dy = (size.height - height) / 2;
    width = size.width;
    height = size.height;

    app.renderer.resize(width, height);
    viewDirty = true;

    // shift the whole layout so it stays centred, without restarting it
    for (const n of graphData.nodes) {
      n.x += dx;
      n.y += dy;
      if (n.fx != null) n.fx += dx;
      if (n.fy != null) n.fy += dy;
    }
    simulation.force('center').x(width / 2).y(height / 2);
    simulation.force('radial')?.x(width / 2).y(height / 2).radius(radialRadius());
    if (enableRadial) simulation.alpha(Math.max(simulation.alpha(), 0.1)).restart();

    zoomBehavior.extent([
      [0, 0],
      [width, height]
    ]);
  }

  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
        });
  resizeObserver?.observe(graph);

  let stopAnimation = false;
  function animate(time) {
    if (stopAnimation) return;

    // Render only while something moves: the simulation is still warm, a
    // tween is running, or the view changed. An idle graph costs nothing.
    const simulating = simulation.alpha() >= simulation.alphaMin();
    const tweening = [...tweens.values()].some((t) => t.active());
    if (!simulating && !tweening && !viewDirty) {
      requestAnimationFrame(animate);
      return;
    }
    viewDirty = false;

    // Geometry follows the simulation every frame; visual state (alpha/scale)
    // is only touched on hover/zoom changes.
    for (const n of nodeRenderData) {
      const { x, y } = n.simulationData;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n.gfx.position.set(x, y);
      if (n.label) n.label.position.set(x, y);
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
      l.gfx.moveTo(linkData.source.x, linkData.source.y);
      l.gfx
        .lineTo(linkData.target.x, linkData.target.y)
        .stroke({ alpha: l.alpha, width: 1, color: l.color });
    }

    tweens.forEach((t) => t.update(time));
    app.renderer.render(stage);
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
  return () => {
    stopAnimation = true;
    resizeObserver?.disconnect();
    removeWheel();
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    simulation.stop();
    tweens.forEach((t) => t.stop());
    tweens.clear();
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

// Listeners attached by the previous `nav` run. `nav` can fire again without a
// page load (settings change re-dispatches it), so they must be removed first,
// otherwise Ctrl+G, icon clicks and themechange would run once per dispatch.
let navCleanups = [];
let navGeneration = 0;

function runNavCleanups() {
  for (const cleanup of navCleanups) cleanup();
  navCleanups = [];
  cleanupLocalGraphs();
  cleanupGlobalGraphs();
}

document.addEventListener('nav', async (e) => {
  runNavCleanups();
  const generation = ++navGeneration;
  const isStale = () => generation !== navGeneration;

  const slug = e.detail.url;
  addToVisited(simplifySlug(slug));

  async function renderLocalGraph() {
    cleanupLocalGraphs();
    const localGraphContainers = document.getElementsByClassName('graph-container');
    for (const container of localGraphContainers) {
      const cleanup = await renderGraph(container, slug);
      // a newer `nav` took over while this graph was loading
      if (isStale()) cleanup();
      else localGraphCleanups.push(cleanup);
    }
  }

  await renderLocalGraph();
  if (isStale()) return;
  const handleThemeChange = () => {
    void renderLocalGraph();
  };

  document.addEventListener('themechange', handleThemeChange);
  navCleanups.push(() => document.removeEventListener('themechange', handleThemeChange));

  const containers = [...document.getElementsByClassName('global-graph-outer')];
  let escapeDisposers = [];

  function isGlobalGraphOpen() {
    return containers.some((container) => container.classList.contains('active'));
  }

  async function renderGlobalGraph() {
    if (isGlobalGraphOpen()) return;
    const currentSlug = getFullSlug(window);
    for (const container of containers) {
      container.classList.add('active');
      // Registered per open and released in hideGlobalGraph(), so repeated
      // open/close never accumulates keydown listeners on `document`.
      escapeDisposers.push(registerEscapeHandler(container, hideGlobalGraph));
    }
    for (const container of containers) {
      const graphContainer = container.querySelector('.global-graph-container');
      if (!graphContainer) continue;
      const cleanup = await renderGraph(graphContainer, currentSlug);
      // closed while the graph was still loading: don't leak the canvas
      if (container.classList.contains('active')) globalGraphCleanups.push(cleanup);
      else cleanup();
    }
  }

  function hideGlobalGraph() {
    cleanupGlobalGraphs();
    for (const dispose of escapeDisposers) dispose();
    escapeDisposers = [];
    for (const container of containers) {
      container.classList.remove('active');
    }
  }

  async function shortcutHandler(e) {
    if (e.key === 'g' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      isGlobalGraphOpen() ? hideGlobalGraph() : renderGlobalGraph();
    }
  }

  const containerIcons = document.getElementsByClassName('global-graph-icon');
  Array.from(containerIcons).forEach((icon) => {
    icon.addEventListener('click', renderGlobalGraph);
    navCleanups.push(() => icon.removeEventListener('click', renderGlobalGraph));
  });

  document.addEventListener('keydown', shortcutHandler);
  navCleanups.push(() => {
    document.removeEventListener('keydown', shortcutHandler);
    hideGlobalGraph();
  });
});
