(function() {
  'use strict';

  const chromep = new ChromePromise();
  const util = openpgp.util;

  const GSC = GoogleSmartCard;
  const Constants = GSC.PcscLiteCommon.Constants;
  const API = GSC.PcscLiteClient.API;

  /**
   * Client title for the connection to the server App.
   *
   * Currently this is only used for the debug logs produced by the server App.
   */
  const CLIENT_TITLE = 'cros-sc-pass';

  /**
   * Identifier of the server App.
   */
  const SERVER_APP_ID = Constants.SERVER_OFFICIAL_APP_ID;

  /**
   * Context for using the PC/SC-Lite client API.
   *
   * This object establishes and manages a connection to the server App. Upon
   * successful connection, a GoogleSmartCard.PcscLiteClient.API object is
   * returned through the callback, that allows to perform PC/SC-Lite client API
   * requests.
   * @type {GSC.PcscLiteClient.Context}
   */
  let context = null;

  let manager = null;

  const State = {
    INIT: 0,
    SEARCHING: 1,
    SHOWING_LOGIN: 2,
    REQUESTING_PIN: 3,
    SHOWING_MESSAGE: 4
  };

  const AppState = {
    _state: State.INIT,
    get state() {
      return this._state;
    },
    set state(state) {
      this._state = state;
      m.redraw();
    },

    activeTab: null,
    currentDomain: '',
    currentUrl: '',
    currentLogins: [],
    hasSearched: false,

    pinCallback: null,
    triesRemaining: 0,
    _fingerprint: '',
    get fingerprint() {
      return `${this._fingerprint.substring(0, 4)} ${this._fingerprint.substring(4)}`;
    },
    set fingerprint(fingerprint) {
      this._fingerprint = fingerprint;
    },

    message: ''
  };

  class AppComponent {
    async oninit() {
      window.addEventListener('unload', async function() {
        if (manager) {
          await manager.disconnect();
          await manager.releaseContext();
        }
      });
      const tabs = await chromep.tabs.query({
        currentWindow: true,
        active: true
      });
      await init(tabs[0]);
    }

    renderResults(results) {
      return [
        m('div.search', [
          m('form', {
            onsubmit: submitSearchForm
          }, [
            m('input', {
              type: 'text',
              name: 'searchBox',
              placeholder: 'Look up other domain...',
              autocomplete: 'off',
              autofocus: 'on'
            }),
            m('input', {
              type: 'submit',
              value: 'Search',
              style: 'display: none;'
            })
          ])
        ]),
        m('div.results', results)
      ];
    }

    view() {
      switch (AppState.state) {
        case State.INIT:
          return [];
        case State.SEARCHING:
          return this.renderResults(m('div.loader'));
        case State.SHOWING_LOGINS:
          let results = [];
          if (AppState.currentLogins.length > 0) {
            const faviconUrl = getFaviconUrl(AppState.currentDomain);
            let tabindex = 1;
            for (const login of AppState.currentLogins) {
              results.push(m('div.login', [
                m('button.login-auto', {
                  onclick: fetchPassword.bind(null, login, false),
                  style: `background-image: url('${faviconUrl}')`,
                  tabindex: tabindex
                }, m.trust(
                  `${login.username}<br/><span class='domain'>${AppState.currentDomain}</span>`
                )),
                m('button.login-copy', {
                  onclick: fetchPassword.bind(null, login, true),
                  tabindex: tabindex + AppState.currentLogins.length
                })
              ]));
              tabindex++;
            }
          } else {
            results = m('div.status-text', m.trust(
              `No passwords found for <strong>${AppState.currentDomain}</strong>.`
            ));
          }
          return this.renderResults(results);
        case State.REQUESTING_PIN:
          return m('div.pin-entry', [
            m('form', {
              onsubmit: AppState.pinCallback
            }, [
              m('input', {
                type: 'password',
                name: 'pinBox',
                placeholder: `PIN (${AppState.triesRemaining} tries remaining)`
              }),
              m('input', {
                type: 'submit',
                value: 'Confirm',
                style: 'display: none;'
              }),
              m('div.info', [
                m('span.fingerprint-info', AppState.fingerprint),
                m('span.reader-info', manager.readerShort)
              ]),
              m('label', [
                m('input', {
                  type: 'checkbox',
                  name: 'cachePinCheckbox',
                  onclick: e => document.getElementsByName(
                    'pinBox')[0].select()
                }),
                m('span',
                  'Cache PIN (until idle for 60s or locked)')
              ])
            ])
          ]);
        case State.SHOWING_MESSAGE:
          return m('div.status-text', m.trust(AppState.message));
      }
    }
  }

  function showMessage(message) {
    AppState.message = message;
    AppState.state = State.SHOWING_MESSAGE;
  }

  function getFaviconUrl(domain) {
    // Use current favicon for logins for current tab
    if (AppState.activeTab && AppState.activeTab.favIconUrl && AppState.activeTab
      .favIconUrl.indexOf(domain) > -1) {
      return AppState.activeTab.favIconUrl;
    }
    // Use cached favicons for all other logins, assuming https. Default icon is
    // an empty page.
    return `chrome://favicon/https://${domain}`;
  }

  async function submitSearchForm(e) {
    e.preventDefault();
    if (AppState.state == State.SEARCHING)
      return;
    const searchBox = e.srcElement.firstChild;
    if (searchBox.value) {
      await fetchLogins(searchBox.value);
    } else {
      // Auto-fill the only login if user hits enter in empty search field and
      // has not searched yet.
      if (AppState.currentLogins.length === 1 && !AppState.hasSearched) {
        fetchPassword(AppState.currentLogins[0], false);
      }
    }
    AppState.hasSearched = true;
  }

  async function init(tab) {
    // do nothing if called from a non-tab context
    if (!tab || !tab.url) {
      return;
    }
    AppState.activeTab = tab;
    // Create dummy <a> element to extract hostname from URL
    const a = document.createElement('a');
    a.href = AppState.activeTab.url;
    AppState.currentDomain = a.hostname.replace('www.', '');
    if (AppState.currentDomain) {
      await fetchLogins(AppState.currentDomain);
    }
  }

  function handleStatus(response) {
    if (response.status >= 200 && response.status < 300) {
      return Promise.resolve(response);
    } else {
      return Promise.reject(new Error(response.statusText));
    }
  }

  function authenticate(interactive) {
    return chromep.identity.getAuthToken({
      interactive
    });
  }

  async function fetchLogins(domain) {
    AppState.currentLogins = [];
    AppState.currentUrl = AppState.activeTab.url;
    AppState.currentDomain = domain;
    AppState.state = State.SEARCHING;

    let logins = [];
    try {
      let token;
      try {
        token = await authenticate(true);
      } catch (error) {
        showMessage('Google Drive authentication failed.');
        logError(error);
        return;
      }
      let query =
        `name = '${domain}' and trashed = false and mimeType = 'application/vnd.google-apps.folder'`;
      let response = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`, {
            method: 'GET',
            headers: new Headers({
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            }),
          })
        .then(handleStatus);
      const directories = await response.json();
      for (const directory of directories.files) {
        const directoryId = directory.id;
        query =
          `'${directoryId}' in parents and trashed = false and (mimeType = 'application/pgp-encrypted' or mimeType = 'application/pgp')`
        response = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`, {
              method: 'GET',
              headers: new Headers({
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              }),
            })
          .then(handleStatus);
        const passFiles = await response.json();
        for (const passFile of passFiles.files) {
          const loginId = passFile.id;
          const username = passFile.name.substring(0, passFile.name.length -
            4);
          logins.push({
            username,
            loginId
          });
        }
      }
    } catch (error) {
      showMessage('Failed to fetch logins from Google Drive.');
      logError(error);
      return;
    }
    AppState.currentLogins = logins;
    AppState.state = State.SHOWING_LOGINS;
  }

  async function copyToClipboard(text, copyDuration) {
    // Replace clipboard content, keep a copy around
    const pastePromise = new Promise(resolve =>
      document.addEventListener('paste', function(event) {
        resolve(event.clipboardData.getData('text/plain'));
        event.preventDefault();
      }, true)
    );
    document.execCommand('paste');
    const oldContent = await pastePromise;

    document.addEventListener('copy', function(event) {
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    }, true);
    // TODO: Find out why the setTimeout is necessary. The event listener is
    // never called if we don't use it.
    setTimeout(() => document.execCommand('copy'), 1);

    showMessage(`Password copied to clipboard for ${copyDuration}s.`);

    const eraseClipboardCode =
      `
    (function() {
      'use strict';

      let timer;

      function eraseClipboard() {
        window.onbeforeunload = null;
        clearTimeout(timer);

        // Restore old content to clipboard
        document.addEventListener('copy', function(event) {
          event.clipboardData.setData('text/plain', ${JSON.stringify(oldContent)});
          event.preventDefault();
        }, true);
        document.execCommand('copy', false, null);

        // Don't show a warning message preventing the user from closing the tab
        return null;
      }

      window.onbeforeunload = e => eraseClipboard();
      timer = setTimeout(eraseClipboard, ${copyDuration * 1000});
    })();
    `;
    chrome.tabs.executeScript({
      code: eraseClipboardCode
    });
  }

  function fillLoginForm(username, password) {
    // Do not send login data to page if URL changed during search.
    if (AppState.activeTab.url != AppState.currentUrl) {
      showMessage('Page URL changed during search.');
      return;
    }

    const autoFillCode =
      `
    (function() {
      'use strict';

      function isVisible(el) {
        const style = window.getComputedStyle(el);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && el.offsetWidth > 0
          && el.offsetHeight > 0
          && el.getClientRects().length;
      }

      function visiblePasswordFields(form) {
        return Array.prototype.filter.call(
          (form || document).querySelectorAll('input[type=password]'),
          isVisible);
      }

      function firstVisiblePasswordField() {
        const passwordFields = visiblePasswordFields();
        if (passwordFields.length >= 1)
          return passwordFields[0];
        else
          return document.createElement('input');
      }

      function form() {
        return firstVisiblePasswordField().form || document.createElement('form');
      }

      function formOrFieldset() {
        return firstVisiblePasswordField().closest('fieldset') || form();
      }

      function field(selector) {
        return formOrFieldset().querySelector(selector)
          || form().querySelector(selector)
          || document.createElement('input');
      }

      function update(el, value) {
        if (!value.length)
          return false;

        el.setAttribute('value', value);
        el.value = value;

        const eventNames = ['click', 'focus', 'keyup', 'keydown', 'change', 'blur'];
        eventNames.forEach(function(eventName) {
          el.dispatchEvent(new Event(eventName, {'bubbles': true}));
        });
        return true;
      }

      update(field('input[type=email], input[type=tel], input[type=text]'), ${JSON.stringify(username)});
      update(firstVisiblePasswordField(), ${JSON.stringify(password)});

      const passwordFields = visiblePasswordFields(formOrFieldset());
      if (passwordFields.length > 1)
        passwordFields[1].select();
      else
        field('[type=submit]').click();
    })();
    `;
    // Some login forms are not part of the top frame. This makes it necessary
    // to inject the autofill code into all frames and use the first visible
    // password field. Being able to set allFrames to true is all we need the
    // http(s)://*/* permission for.
    chrome.tabs.executeScript({
      code: autoFillCode,
      allFrames: true
    });
    window.close();
  }

  class OpenPGPSmartCardManager {
    constructor(api) {
      this.api = api;
      this.connected = false;
      this.context = 0;
      this.reader = null;
      this.cardHandle = 0;
      this.activeProtocol = 0;
      this.appletSelected = false;
    }

    get readerShort() {
      if (this.reader.includes('Yubikey NEO-N'))
        return 'Yubikey NEO-N';
      else if (this.reader.includes('Yubikey NEO'))
        return 'YubiKey NEO';
      else if (this.reader.includes('Yubikey 4'))
        return 'YubiKey 4';
      else
        return this.reader;
    }

    async establishContext() {
      if (!(await this.isValidContext())) {
        this.context = await this._execute(this.api.SCardEstablishContext(
          API.SCARD_SCOPE_SYSTEM, null, null));
      }
    }

    async isValidContext() {
      try {
        await this._execute(this.api.SCardIsValidContext(this.context));
      } catch (_) {
        return false;
      }
      return true;
    }

    async listReaders() {
      if ((await this.isValidContext()) && !this.connected) {
        return this._execute(this.api.SCardListReaders(this.context, null));
      }
    }

    async connect(reader) {
      if ((await this.isValidContext()) && !this.connected) {
        this.reader = reader;
        [this.cardHandle, this.activeProtocol] = await this._execute(this.api
          .SCardConnect(this.context,
            this.reader,
            API.SCARD_SHARE_EXCLUSIVE,
            API.SCARD_PROTOCOL_T1));
        this.connected = true;
      }
    }

    _execute(sCardPromise) {
      return sCardPromise.then(result => new Promise(
        function(resolve, reject) {
          result.get((...args) => args.length > 1 ? resolve(args) :
            resolve(
              args[0]), reject);
        }));
    }

    async _getData(result) {
      result[1] = new Uint8Array(result[1]);
      let data = result[1].slice(0, -2);
      const returnCode = result[1].slice(-2);
      if (returnCode[0] === 0x61) {
        const dataContinued = await this.transmit(new CommandAPDU(0x00,
          0xC0, 0x00, 0x00));
        data = util.concatUint8Array([data, dataContinued]);
      } else if (!(returnCode[0] === 0x90 && returnCode[1] === 0x00)) {
        console.log('Operation returned specific status bytes:', returnCode);
        throw returnCode;
      }
      return data;
    }

    async transmit(commandAPDU) {
      if (this.connected) {
        let data = null;
        for (const command of commandAPDU.commands) {
          const result = await this._execute(this.api.SCardTransmit(this.cardHandle,
            API.SCARD_PCI_T1, Array.from(command)));
          data = await this._getData(result);
        }
        return data;
      }
    }

    async selectApplet() {
      if (this.connected && !this.appletSelected) {
        await this.transmit(new CommandAPDU(0x00, 0xA4, 0x04, 0x00, new Uint8Array(
          [0xD2, 0x76, 0x00, 0x01, 0x24, 0x01])));
        this.appletSelected = true;
      }
    }

    async disconnect() {
      if (this.connected) {
        await this._execute(this.api.SCardDisconnect(this.cardHandle, API.SCARD_LEAVE_CARD));
        this.appletSelected = false;
        this.connected = false;
        this.reader = null;
        this.cardHandle = 0;
        this.activeProtocol = 0;
      }
    }

    async releaseContext() {
      if ((await this.isValidContext()) && !this.connected) {
        await this._execute(this.api.SCardReleaseContext(this.context));
        this.context = 0;
      }
    }
  }

  class CommandAPDU {
    constructor(cla, ins, p1, p2, data) {
      this.commands = [];

      if (!data) {
        this.commands.push(new Uint8Array([cla, ins, p1, p2, 0x00]));
        return;
      }

      let remainingBytes = data.length;

      while (remainingBytes > 0xFF) {
        const header = new Uint8Array([cla | 1 << 4, ins, p1, p2, 0xFF]);
        const body = data.subarray(data.length - remainingBytes, data.length -
          remainingBytes + 0xFF);
        const footer = new Uint8Array([0x00]);
        this.commands.push(util.concatUint8Array([header, body, footer]));
        remainingBytes -= 0xFF;
      }

      const header = new Uint8Array([cla, ins, p1, p2, remainingBytes]);
      const body = data.subarray(data.length - remainingBytes, data.length);
      const footer = new Uint8Array([0x00]);
      this.commands.push(util.concatUint8Array([header, body, footer]));
    }
  }

  const DATA_OBJECT_TAG = {
    0x5E: 'Login data',
    0x5F50: 'URL to public keys',

    0x65: 'Cardholder Related Data',
    0x5B: 'Name',
    0x5F2D: 'Language preference',
    0x5F35: 'Sex',

    0x6E: 'Application Related Data',
    0x4F: 'Application Identifier',
    0x5F52: 'Historical bytes',
    0x73: 'Discretionary data objects',
    0xC0: 'Extended capabilities',
    0xC1: 'Algorithm attributes: signature',
    0xC2: 'Algorithm attributes: decryption',
    0xC3: 'Algorithm attributes: authentication',
    0xC4: 'PW Status Bytes',
    0xC5: 'Fingerprints',
    0xC6: 'CA Fingerprints',
    0xCD: 'Generation Timestamps',

    0x7A: 'Security support template',
    0x93: 'Digital signature counter'
  };

  const DATA_OBJECT_TAG_CLASS = {
    0: 'universal',
    1: 'application',
    2: 'context-specific',
    3: 'private'
  };

  class DataObject {

    lookup(tag) {
      if (this.tag === tag)
        if (this.isConstructed)
          return this.children;
        else
          return this.value;
      else {
        if (this.isConstructed) {
          for (let child of this.children) {
            let result = child.lookup(tag);
            if (result !== null)
              return result;
          }
        }
        return null;
      }
    }

    static fromBytesWithStart(bytes, start) {
      let pos = start;
      if (pos < bytes.length) {
        const dataObject = new DataObject();
        const tagByte = bytes[pos++];
        dataObject.tagClass = tagByte >>> 6;
        dataObject.tagClassDescription = DATA_OBJECT_TAG_CLASS[dataObject.tagClass];
        const isConstructed = !!(tagByte & (1 << 5));
        dataObject.isConstructed = isConstructed;

        let tagNumber = tagByte & 0b00011111;
        let numTagNumberBytes = 1;
        if (tagNumber === 0b00011111) {
          if (!(bytes[pos] & 0b01111111))
            throw Error('First byte of the tag number is 0');
          tagNumber = 0;
          do {
            tagNumber = (tagNumber << 7) + bytes[pos] & 0b01111111;
            ++numTagNumberBytes;
          } while (bytes[pos++] & (1 << 7));
        }
        dataObject.tagNumber = tagNumber;
        dataObject.tag = util.readNumber(bytes.slice(pos -
          numTagNumberBytes, pos));
        dataObject.tagDescription = DATA_OBJECT_TAG[dataObject.tag] ||
          `<unimplemented tag: ${dataObject.tag}>`;

        const lengthByte = bytes[pos++];
        let valueLength = 0;
        if (lengthByte <= 0x7F) {
          valueLength = lengthByte;
        } else {
          const numLengthBytes = lengthByte & 0b01111111;
          for (let i = 0; i < numLengthBytes; ++i) {
            valueLength = (valueLength * 0x100) + bytes[pos++];
          }
        }
        dataObject.valueLength = valueLength;

        const valueStart = pos;
        const valueEnd = pos + valueLength;
        const value = bytes.slice(valueStart, valueEnd);

        if (isConstructed) {
          dataObject.children = [];
          while (pos < valueEnd) {
            // Skip zero bytes inbetween tags
            if (!bytes[pos]) {
              ++pos;
              continue;
            }
            let child;
            [child, pos] = DataObject.fromBytesWithStart(bytes, pos);
            dataObject.children.push(child);
          }
        } else {
          dataObject.value = value;
        }
        return [dataObject, valueEnd];
      } else {
        return [null, start];
      }
    }

    static fromBytes(bytes) {
      return DataObject.fromBytesWithStart(bytes, 0)[0];
    }
  }

  async function initializeContext() {
    if (!context || !manager) {
      context = new GSC.PcscLiteClient.Context(CLIENT_TITLE, SERVER_APP_ID);
      // Wait for an API context for at most 2 seconds
      const api = await Promise.race([
        new Promise(function(resolve) {
          context.addOnInitializedCallback(resolve);
          context.addOnDisposeCallback(contextDisposedListener);
          context.initialize();
        }),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
      if (api)
        manager = new OpenPGPSmartCardManager(api);
      else
        throw Error(
          'Smart Card Connector extension not installed or disabled.')
    }
    await manager.establishContext();
  }


  async function logError(error) {
    // Numeric error codes signify PC/SC-Lite errors
    if (typeof error === 'number') {
      console.log('failed: PC/SC-Lite error: ' + error);
      try {
        const errorText = await manager.api.pcsc_stringify_error(error);
        console.log('PC/SC-Lite error text: ' + errorText);
      } catch (e) {
        console.log(e);
      }
    } else {
      console.log(error);
    }
  }

  async function fetchPassword(login, copy) {
    try {
      await initializeContext();
    } catch (error) {
      showMessage(
        'Please install the <a href="https://chrome.google.com/webstore/detail/smart-card-connector/khpfeaanjngmcnplbdlpegiifgpfgdco" target="_blank">Smart Card Connector extension</a>.'
      )
      logError(error);
      return;
    }

    try {
      const token = await authenticate(true);
      const response = await fetch(
          `https://www.googleapis.com/drive/v3/files/${login.loginId}?alt=media`, {
            method: 'GET',
            headers: new Headers({
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            }),
          })
        .then(handleStatus);
      const encryptedPasswordBuffer = await response.arrayBuffer();
      const encryptedPassword = new Uint8Array(encryptedPasswordBuffer);

      let pgpMessage;
      // First try to read binary signature, if that fails expect ASCII armor
      try {
        pgpMessage = openpgp.message.read(encryptedPassword);
      } catch (_) {
        try {
          pgpMessage = openpgp.message.readArmored(util.bin2str(
            encryptedPassword));
        } catch (error) {
          showMessage('Encrypted file is malformed.')
          logError(error);
          return;
        }
      }
      const pkESKeyPacket = pgpMessage.packets.filterByTag(openpgp.enums.packet
        .publicKeyEncryptedSessionKey)[0];
      const encryptedSessionKey = pkESKeyPacket.encrypted[0].write();
      const publicKeyId = pkESKeyPacket.publicKeyId.write();

      const decryptedSessionKey = await decryptOnSmartCard(
        encryptedSessionKey, publicKeyId);
      if (!decryptedSessionKey) return;

      const symmetricAlgorithm = decryptedSessionKey[0];
      const checksum = (decryptedSessionKey[decryptedSessionKey.length - 2] <<
        8) + decryptedSessionKey[decryptedSessionKey.length - 1];
      const data = decryptedSessionKey.subarray(1, decryptedSessionKey.length -
        2);
      if (checksum !== util.calc_checksum(data)) {
        showMessage('Checksum mismatch, encrypted file is malformed.');
        return;
      }
      const sessionKey = {
        data,
        algorithm: openpgp.enums.read(openpgp.enums.symmetric,
          symmetricAlgorithm)
      };
      const decryptedMessage = await pgpMessage.decrypt(null, sessionKey,
        null);
      let password;
      if (decryptedMessage.packets[0].tag === openpgp.enums.packet.compressed)
        password = util.bin2str(decryptedMessage.packets[0].packets[0].data);
      else
        password = util.bin2str(decryptedMessage.packets[0].data);

      if (copy) {
        copyToClipboard(password, 30);
      } else {
        fillLoginForm(login.username, password);
      }
    } catch (error) {
      showMessage('Failed to fetch logins from Google Drive.');
      logError(error);
      return;
    } finally {
      await manager.disconnect();
      await manager.releaseContext();
    }
  }

  async function connectToReaderByPublicKeyId(keyId) {
    let readers;
    try {
      readers = await manager.listReaders();
    } catch (error) {
      showMessage('Failed to list readers.');
      logError(error);
      return;
    }
    let readerFound = false;
    for (const reader of readers) {
      try {
        await manager.connect(reader);
      } catch (error) {
        console.log(`Failed to connect to reader ${reader}, skipping.`);
        logError(error);
        continue;
      }
      let readerKeyId;
      try {
        await manager.selectApplet();
        readerKeyId = await getPublicKeyId();
      } catch (error) {
        console.log(
          `Failed to get public key ID from reader ${reader}, skipping.`);
        logError(error);
        await manager.disconnect();
        continue;
      }
      if (util.equalsUint8Array(readerKeyId, keyId)) {
        readerFound = true;
        break;
      }
      await manager.disconnect();
    }
    return readerFound;
  }

  async function getPublicKeyId() {
    const appRelatedData = DataObject.fromBytes(await manager.transmit(
      new CommandAPDU(0x00, 0xCA, 0x00, 0x6E)));
    return appRelatedData.lookup(0xC5).subarray(32, 40);
  }

  async function requestAndVerifyPin() {
    let pin = await chromep.runtime.sendMessage({
      method: 'get',
      body: {
        key: AppState._fingerprint,
        reader: manager.reader
      }
    });
    let cachePin = false;
    const appRelatedData = DataObject.fromBytes(await manager.transmit(
      new CommandAPDU(0x00, 0xCA, 0x00, 0x6E)));
    AppState.triesRemaining = appRelatedData.lookup(0xC4)[4];
    // Only use the cached PIN if it cannot lead to a locked smart card
    if (!pin || AppState.triesRemaining <= 1) {
      const pinPromise = new Promise(function(resolve) {
        AppState.pinCallback = function(e) {
          e.preventDefault();
          AppState.pinCallback = null;
          resolve(document.getElementsByName('pinBox')[0].value);
        };
      });
      AppState.state = State.REQUESTING_PIN;
      if (AppState.triesRemaining === 0)
        document.getElementsByName('pinBox')[0].readOnly = true;
      document.getElementsByName('pinBox')[0].value = '';
      document.getElementsByName('pinBox')[0].select();
      // Wait for user to enter PIN
      pin = await pinPromise;
      cachePin = document.getElementsByName('cachePinCheckbox')[0].checked;
    }
    const pinBytes = util.str2Uint8Array(util.encode_utf8(pin));
    // Verify PIN for decryption
    try {
      await manager.transmit(new CommandAPDU(0x00, 0x20, 0x00, 0x82, pinBytes));
      // At this point PIN verification has succeeded
      if (cachePin) {
        await chromep.runtime.sendMessage({
          method: 'put',
          body: {
            key: AppState._fingerprint,
            reader: manager.reader,
            pin: pin
          }
        });
      }
    } catch (error) {
      if (util.isUint8Array(error) && error.length === 2) {
        // Special status bytes
        switch (util.readNumber(error)) {
          // Invalid PIN, ask again
          case 0x6982:
            // Delete the (invalid) PIN if cached
            // This should only ever happen if the user changes the PIN while it
            // is still cached. Requires a very fast user.
            if (cachePin)
              chromep.runtime.sendMessage({
                method: 'delete',
                body: {
                  key: AppState._fingerprint,
                  reader: manager.reader
                }
              });
            await requestAndVerifyPin();
            break;
            // Device is blocked (this should not be reached as we check the
            // number of remaining tries and block PIN entry in this case)
          case 0x6983:
            throw Error('Device is blocked.');
          default:
            throw error;
        }
      } else {
        // pcsclite error
        throw error;
      }
    }
  }

  async function decryptOnSmartCard(encryptedSessionKey, publicKeyId) {
    AppState.fingerprint = util.hexidump(publicKeyId.slice(4)).toUpperCase();
    if (!await connectToReaderByPublicKeyId(publicKeyId)) {
      showMessage(`No reader found for key ${AppState.fingerprint}.`);
      return;
    }
    try {
      await requestAndVerifyPin();
    } catch (error) {
      showMessage('PIN verification failed.');
      logError(error);
      return;
    }
    let decryptedSessionKey;
    try {
      decryptedSessionKey = await manager.transmit(new CommandAPDU(0x00, 0x2A,
        0x80, 0x86,
        util.concatUint8Array(
          [new Uint8Array([0x00]), encryptedSessionKey.subarray(2)])));
    } catch (error) {
      showMessage('Decryption failed.');
      logError(error);
      return;
    }
    await manager.disconnect();
    await manager.releaseContext();

    return decryptedSessionKey;
  }

  function contextDisposedListener() {
    context = null;
    manager = null;
  }

  m.mount(document.body, AppComponent);
})();
