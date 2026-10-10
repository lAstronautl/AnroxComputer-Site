/**
 * Keeps small pixel-art images crisp without wrecking big ones.
 *
 * `image-rendering: pixelated` is great when a 32x32 icon is scaled UP, but it
 * drops thin lines when a big picture (a map, a screenshot) is scaled DOWN.
 * So the class is only set while the image is actually shown larger than its
 * natural size; everything else keeps the browser's smooth scaling.
 */

const SELECTOR = '.preview-img img, .col-md-5 > img, .post-thumb';
const CLASS_NAME = 'pixelated';

function update(img) {
  if (!img.naturalWidth || !img.naturalHeight) return;

  // `object-fit: contain` draws the picture at the smaller of the two ratios
  const scale = Math.min(
    img.clientWidth / img.naturalWidth,
    img.clientHeight / img.naturalHeight
  );

  img.classList.toggle(CLASS_NAME, scale > 1);
}

export function initPixelArt() {
  const images = [...document.querySelectorAll(SELECTOR)];
  if (images.length === 0) return;

  const updateAll = () => images.forEach(update);

  images.forEach((img) => {
    img.addEventListener('load', () => update(img));
    if (img.complete) update(img);
  });

  let frame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(updateAll);
  });
}
