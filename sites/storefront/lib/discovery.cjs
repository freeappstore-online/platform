// Registry visibility is independent of resource provisioning and temporary uptime.
const STATUSES = new Set(['live', 'published', 'approved']);
function permitsDiscovery(app) {
  return (app.status === undefined || STATUSES.has(app.status)) && app.private !== true &&
    (app.visibility === undefined || ['public', 'published'].includes(app.visibility));
}
function isPublicListing(app) {
  return permitsDiscovery(app) && (app.discoveryStatus === undefined || app.discoveryStatus === 'live');
}
function isPendingListing(app) {
  return permitsDiscovery(app) && app.discoveryStatus === 'pending';
}
module.exports = { isPublicListing, isPendingListing };
