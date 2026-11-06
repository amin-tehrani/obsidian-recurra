// Loads main.js with a minimal stand-in for the `obsidian` module (only needed at require time).
const Module = require('module');
const path = require('path');

function loadPlugin(obsidianOverrides) {
  const file = path.join(__dirname, '..', 'main.js');
  delete require.cache[require.resolve(file)];
  class Stub {}
  const fake = Object.assign({
    Plugin: Stub, PluginSettingTab: Stub, Setting: Stub, Modal: Stub, Notice: Stub, MarkdownRenderChild: Stub,
    requestUrl: () => { throw new Error('no network in tests'); },
    Platform: { isDesktopApp: true, isMobile: false },
  }, obsidianOverrides || {});
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'obsidian' ? fake : orig.call(this, req, ...rest); };
  try { return require(file); } finally { Module._load = orig; }
}

module.exports = { loadPlugin };
