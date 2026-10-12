import Toast from 'bootstrap/js/src/toast';

if ('serviceWorker' in navigator) {
  // Get Jekyll config from URL parameters
  const src = new URL(document.currentScript.src);
  const register = src.searchParams.get('register');
  const baseUrl = src.searchParams.get('baseurl');

  if (register) {
    const swUrl = `${baseUrl}/sw.min.js`;
    const notification = document.getElementById('notification');
    const btnRefresh = notification.querySelector('.toast-body>button');
    const popupWindow = Toast.getOrCreateInstance(notification);

    navigator.serviceWorker.register(swUrl).then((registration) => {
      // Show the update window whenever a new version is waiting (also when it was closed on an earlier visit)
      const showIfWaiting = () => {
        if (registration.waiting && navigator.serviceWorker.controller) {
          popupWindow.show();
        }
      };
      showIfWaiting();

      // Look for a new version on load, when the tab comes back and every few minutes,
      // so the button appears reliably instead of only after a lucky navigation
      const check = () => {
        registration.update().then(showIfWaiting, () => {});
      };
      check();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          check();
        }
      });
      setInterval(check, 5 * 60 * 1000);

      registration.addEventListener('updatefound', () => {
        registration.installing.addEventListener('statechange', () => {
          if (registration.waiting) {
            if (navigator.serviceWorker.controller) {
              popupWindow.show();
            }
          }
        });
      });

      btnRefresh.addEventListener('click', () => {
        if (registration.waiting) {
          registration.waiting.postMessage('SKIP_WAITING');
        }
        popupWindow.hide();
      });
    });

    let refreshing = false;

    // Detect controller change and refresh all the opened tabs
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        window.location.reload();
        refreshing = true;
      }
    });
  } else {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      for (let registration of registrations) {
        registration.unregister();
      }
    });
  }
}
