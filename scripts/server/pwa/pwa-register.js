(() => {
  if (!('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // installability is a progressive enhancement; never break the app over it
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
