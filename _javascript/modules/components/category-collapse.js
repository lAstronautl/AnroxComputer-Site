/**
 * Tab 'Categories' expand/close effect.
 * Works for every nesting level (category / sub-category / post / heading):
 * each `.collapse` panel is toggled by a trigger whose `href="#<panel-id>"`
 * points back to it, so the trigger is found by that relationship instead
 * of a fixed id-prefix scheme.
 */

import 'bootstrap/js/src/collapse.js';

const panels = document.getElementsByClassName('collapse');

export function categoryCollapse() {
  [...panels].forEach((elem) => {
    const trigger = document.querySelector(`a[href="#${elem.id}"]`);
    if (!trigger) return;

    const parent = trigger.closest('.card-header, .d-flex');
    const arrow = trigger.querySelector('.fas.fa-angle-down');
    const folderOpen = parent ? parent.querySelector('.far.fa-folder-open') : null;
    const folderClosed = parent ? parent.querySelector('.far.fa-folder') : null;

    // collapse
    elem.addEventListener('hide.bs.collapse', () => {
      if (folderOpen) folderOpen.className = 'far fa-folder fa-fw';
      if (arrow) arrow.classList.add('rotate');
      if (parent) parent.classList.remove('hide-border-bottom');
    });

    // expand
    elem.addEventListener('show.bs.collapse', () => {
      if (folderClosed) folderClosed.className = 'far fa-folder-open fa-fw';
      if (arrow) arrow.classList.remove('rotate');
      if (parent) parent.classList.add('hide-border-bottom');
    });
  });
}
