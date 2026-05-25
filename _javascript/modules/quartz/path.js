// Minimal subset of Quartz `util/path.ts` required by graph view.

export function getFullSlug(win) {
  return win.document.body.dataset.slug;
}

function trimSuffix(s, suffix) {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

function stripSlashes(s, removeTrailing = false) {
  let out = s;
  if (out.startsWith('/')) out = out.slice(1);
  if (removeTrailing && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

export function simplifySlug(fp) {
  const res = stripSlashes(trimSuffix(fp, 'index'), true);
  return res.length === 0 ? '/' : res;
}

export function joinSegments(...args) {
  if (args.length === 0) return '';

  let joined = args
    .filter((segment) => segment !== '' && segment !== '/')
    .map((segment) => {
      let s = segment;
      if (s.startsWith('/')) s = s.slice(1);
      if (s.endsWith('/')) s = s.slice(0, -1);
      return s;
    })
    .join('/');

  if (args[0].startsWith('/')) joined = '/' + joined;
  if (args[args.length - 1].endsWith('/')) joined = joined + '/';
  return joined;
}

export function pathToRoot(slug) {
  let rootPath = slug
    .split('/')
    .filter((x) => x !== '')
    .slice(0, -1)
    .map(() => '..')
    .join('/');

  if (rootPath.length === 0) rootPath = '.';
  return rootPath;
}

export function resolveRelative(current, target) {
  return joinSegments(pathToRoot(current), simplifySlug(target));
}
