// The FreeGameStore registry the homepage search federates with. It lives in
// the FGS platform monorepo; freegamestore-online/freegamestore is archived.
const CROSS_STORE_REGISTRY_PATH = '/freegamestore-online/platform/main/sites/freegamestore/registry.json';

// Same rule as the FGS storefront build: pending/failed games are not listed.
const NON_LIVE = new Set(['pending', 'failed']);

function crossStoreItems(parsed) {
  const games = Array.isArray(parsed?.games) ? parsed.games : [];
  return games.filter((game) => !NON_LIVE.has(game.status));
}

module.exports = { CROSS_STORE_REGISTRY_PATH, crossStoreItems };
