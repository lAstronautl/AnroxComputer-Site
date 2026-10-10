export function registerEscapeHandler(outsideContainer, cb) {
  if (!outsideContainer) return () => {};

  function click(e) {
    if (e.target !== outsideContainer) return;
    e.preventDefault();
    e.stopPropagation();
    cb();
  }

  function esc(e) {
    if (!e.key || !e.key.startsWith('Esc')) return;
    e.preventDefault();
    cb();
  }

  outsideContainer.addEventListener('click', click);
  document.addEventListener('keydown', esc);

  // Caller owns the lifetime: call the returned function when the container is
  // closed so listeners do not pile up on every open.
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    outsideContainer.removeEventListener('click', click);
    document.removeEventListener('keydown', esc);
  };
}

export function removeAllChildren(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

