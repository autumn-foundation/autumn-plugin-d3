// E2E fixture: a deferred page script after d3_script(). It must still
// get d3:ready, because init.js starts on DOMContentLoaded.
window.__lateReady = [];
document.addEventListener("d3:ready", (event) => window.__lateReady.push(event.target.id));
