(function() {
  'use strict';

  function clearClipboard() {
    document.addEventListener('copy', function(event) {
      event.clipboardData.setData('text/plain', '');
      event.preventDefault();
      document.removeEventListener('copy', this);
    });
    document.execCommand('copy');
  }

  chrome.alarms.onAlarm.addListener(function(alarm) {
    if (alarm.name === 'clearClipboard')
      clearClipboard();
  });
})();
