/**
 * Interactive image map: hoverable/clickable polygon zones with an
 * animated tooltip card. Optionally fetches a linked post's preview.
 */

const previewCache = new Map();

function fetchPostPreview(url) {
  if (previewCache.has(url)) {
    return previewCache.get(url);
  }

  const promise = fetch(url)
    .then((res) => (res.ok ? res.text() : null))
    .then((html) => {
      if (!html) return null;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const title = doc.querySelector('h1')?.textContent?.trim() ?? '';
      const image = doc.querySelector('.preview-img')?.getAttribute('src') ?? null;
      const description =
        doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
      return { title, image, description };
    })
    .catch(() => null);

  previewCache.set(url, promise);
  return promise;
}

function buildTooltipBody(zone, tooltipBody) {
  const link = zone.dataset.link;

  if (!link) {
    tooltipBody.textContent = zone.dataset.text ?? '';
    return;
  }

  tooltipBody.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'interactive-map-tooltip-cta';
  label.textContent = zone.dataset.linkLabel ?? 'Нажмите, чтобы открыть';
  tooltipBody.appendChild(label);

  const preview = document.createElement('div');
  preview.className = 'interactive-map-tooltip-preview';
  preview.hidden = true;
  tooltipBody.appendChild(preview);

  fetchPostPreview(link).then((data) => {
    if (!data) return;
    preview.hidden = false;

    if (data.image) {
      const img = document.createElement('img');
      img.src = data.image;
      img.alt = data.title;
      preview.appendChild(img);
    }

    if (data.description) {
      const desc = document.createElement('p');
      desc.textContent = data.description;
      preview.appendChild(desc);
    }
  });
}

function positionTooltip(tooltip, container, event) {
  const rect = container.getBoundingClientRect();
  let x = event.clientX - rect.left + 16;
  let y = event.clientY - rect.top + 16;

  const tooltipRect = tooltip.getBoundingClientRect();
  if (x + tooltipRect.width > rect.width) {
    x = event.clientX - rect.left - tooltipRect.width - 16;
  }
  if (y + tooltipRect.height > rect.height) {
    y = event.clientY - rect.top - tooltipRect.height - 16;
  }

  tooltip.style.left = `${Math.max(0, x)}px`;
  tooltip.style.top = `${Math.max(0, y)}px`;
}

function initMap(container) {
  const tooltip = container.querySelector('[data-interactive-map-tooltip]');
  const tooltipTitle = container.querySelector('[data-tooltip-title]');
  const tooltipBody = container.querySelector('[data-tooltip-body]');
  const zones = container.querySelectorAll('.interactive-map-zone');

  if (!tooltip || zones.length === 0) return;

  let activeZone = null;

  const showTooltip = (zone, event) => {
    activeZone = zone;
    tooltipTitle.textContent = zone.dataset.title ?? '';
    buildTooltipBody(zone, tooltipBody);

    tooltip.hidden = false;
    positionTooltip(tooltip, container, event);

    requestAnimationFrame(() => {
      tooltip.classList.add('is-visible');
    });
  };

  const hideTooltip = () => {
    activeZone = null;
    tooltip.classList.remove('is-visible');
    tooltip.addEventListener(
      'transitionend',
      () => {
        if (!activeZone) tooltip.hidden = true;
      },
      { once: true }
    );
  };

  zones.forEach((zone) => {
    zone.addEventListener('mouseenter', (event) => showTooltip(zone, event));
    zone.addEventListener('mousemove', (event) => {
      if (activeZone === zone) positionTooltip(tooltip, container, event);
    });
    zone.addEventListener('mouseleave', hideTooltip);
    zone.addEventListener('focus', (event) => showTooltip(zone, event));
    zone.addEventListener('blur', hideTooltip);

    zone.addEventListener('click', () => {
      const link = zone.dataset.link;
      if (link) window.location.href = link;
    });
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        const link = zone.dataset.link;
        if (link) window.location.href = link;
      }
    });
  });
}

export function initInteractiveMaps() {
  document.querySelectorAll('.interactive-map').forEach((container) => initMap(container));
}
