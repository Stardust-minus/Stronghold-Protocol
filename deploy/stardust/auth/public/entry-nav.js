(() => {
  'use strict';
  if (!['/', '/index.html'].includes(location.pathname)
    && !/^\/_release\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/public\/(?:index\.html)?$/.test(location.pathname)) return;
  const url = new URL(location.href);
  if (url.searchParams.get('_prts') !== '1') return;
  // This marker only prevents an animation redirect loop; it never grants authorization.
  // Remove it immediately so reloads/bookmarks go through the opening sequence again.
  url.searchParams.delete('_prts');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
})();
