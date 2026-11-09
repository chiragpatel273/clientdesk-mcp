// Applies the saved theme before first paint so there is no light/dark flash.
// A separate file (not inline) so it works under a strict Content-Security-Policy.
(function () {
  var theme = 'system';
  try {
    theme = localStorage.getItem('clientdesk.theme') || 'system';
  } catch {
    // Storage blocked: fall back to the system preference.
  }
  var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
})();
