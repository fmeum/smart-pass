(async function() {
  'use strict';
  
  const chromep = new ChromePromise();
  
  const MENU_ID_CLEAR_CACHE = 'smart-pass.clear-cache';
  
  let pinCache = {}; 
  
  function clearCache() {
    pinCache = {};
    chrome.browserAction.setBadgeText({text: ''});
  }
  
  function putPin(key, reader, pin) {
    if (!(key in pinCache))
      pinCache[key] = {};
    pinCache[key][reader] = pin;
    chrome.browserAction.setBadgeText({text: 'PIN'});
  }
  
  function getPin(key, reader) {
    if (key in pinCache) 
      if (reader in pinCache[key])
        return pinCache[key][reader];
    return null;
  }
  
  function deletePin(key, reader) {
    if (key in pinCache) {
      // Remove reader (or do nothing if not present)
      pinCache[key].pop(reader, null);
      // Remove key if it has no other readers assigned
      if (Object.keys(pinCache[key]).length === 0)
        pinCache.pop(key);
    }
    if (Object.keys(pinCache).length === 0)
      chrome.browserAction.setBadgeText({text: ''});
  }
  
  chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
      // Do not accept messages from content scripts (we don't have any)
      if (sender.tab)
        return;
        
      const body = request.body;
      switch (request.method) {
        case 'put':
          putPin(body.key, body.reader, body.pin);
          sendResponse(true);
          break;
        case 'get':
          sendResponse(getPin(body.key, body.reader));
          break;
        case 'delete':
          deletePin(body.key, body.reader);
          sendResponse(true);
          break;
      }
      return false;
  });
  
  chrome.idle.setDetectionInterval(60);
  chrome.idle.onStateChanged.addListener(function(state) {
    if (state === "idle" || state === "locked")
      clearCache();
  });
  
  await chromep.contextMenus.removeAll();
  await chromep.contextMenus.create({
    id: MENU_ID_CLEAR_CACHE,
    title: 'Clear PIN cache',
    contexts: ['browser_action'],
    onclick: clearCache
  });
})();
