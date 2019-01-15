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
  const CLIENT_TITLE = 'smart-pass';

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
            let tabindex = 1;
            for (const login of AppState.currentLogins) {
              results.push(m('div.login', [
                m('button.login-auto', {
                  onclick: fetchPassword.bind(null, login, false),
                  style: `background-image: url('${login.faviconUrl}')`,
                  tabindex: tabindex
                }, [
                  m.trust(login.username),
                  m('br'),
                  m('span.domain-prefix',
                    login.domainPrefix + (login.domainPrefix ? '.' :
                      '')),
                  m('span.domain-suffix', login.domainSuffix)
                ]),
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

  const CHROME_EMPTY_PAGE_FAVICON_BASE64 =
    `77+9UE5HDQoaCgAAAA1JSERSAAAAEAAAABAIBAAAAO+/ve+/vTfvv70AAAAySURBVHgBYyASRO+/vUfvv70NWBUgKX0Q1YBXQe+/vQLvv70S77+9MDIL77+9BO+/vQIYRFfvv70GRu+/vQJMSGQ8AwBs77+9Q1Pvv70dCDkAAAAASUVORO+/vUJg77+9`;

  // https://developer.mozilla.org/en-US/docs/Web/API/WindowBase64/Base64_encoding_and_decoding#Solution_1_–_escaping_the_string_before_encoding_it
  function b64EncodeUnicode(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(
      match, p1) {
      return String.fromCharCode('0x' + p1);
    }));
  }

  async function getFaviconUrl(domain) {
    // Use current favicon for logins for current tab and domain
    if (AppState.activeTab &&
      AppState.activeTab.favIconUrl &&
      extractHostname(AppState.activeTab.favIconUrl) === domain) {
      return AppState.activeTab.favIconUrl;
    }
    // Use cached favicons for all other logins, assuming https. Default icon is
    // an empty page. If '<domain>' results in the default icon, we assume
    // that the correct domain is 'www.<domain>'.
    let faviconUrl = `chrome://favicon/https://${domain}`;
    const faviconBase64 = await m.request({
      method: 'GET',
      url: faviconUrl,
      deserialize: response => b64EncodeUnicode(response)
    });
    if (faviconBase64 === CHROME_EMPTY_PAGE_FAVICON_BASE64)
      faviconUrl = `chrome://favicon/https://www.${domain}`;
    return faviconUrl;
  }

  async function submitSearchForm(e) {
    e.preventDefault();
    if (AppState.state === State.SEARCHING)
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

  function extractHostname(domain) {
    const a = document.createElement('a');
    a.href = domain;
    return a.hostname.replace(/^www\./, '');
  }

  async function init(tab) {
    // do nothing if called from a non-tab context
    if (!tab || !tab.url) {
      return;
    }
    AppState.activeTab = tab;
    AppState.currentDomain = extractHostname(AppState.activeTab.url);
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
      // If the current domain is e.g. (www.)a.b.c.com, we search for logins for
      // the domains:
      // a.b.c.com, b.c.com, c.com
      const domainParts = domain.split('.');
      let domainSplittings = [];
      for (let i = 0; i < domainParts.length; i++) {
        // We do not split off the (last part of the) TLD, unless the domain does
        // not contain a period (e.g. localhost).
        if (i === domainParts.length - 1 && domainParts.length !== 1)
          break;
        const domainPrefix = domainParts.slice(0, i).join('.');
        const domainSuffix = domainParts.slice(i).join('.');
        domainSplittings.push([domainPrefix, domainSuffix]);
      }
      await Promise.all(domainSplittings.map(async function(splitting) {
        const [domainPrefix, domainSuffix] = splitting;
        const faviconUrl = await getFaviconUrl(domainSuffix);
        const query =
          `name = '${domainSuffix}' and trashed = false and mimeType = 'application/vnd.google-apps.folder'`;
        const response = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`, {
              method: 'GET',
              headers: new Headers({
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              })
            })
          .then(handleStatus);
        const directories = await response.json();
        await Promise.all(directories.files.map(async function(
          directory) {
          const directoryId = directory.id;
          const loginQuery =
            `'${directoryId}' in parents and trashed = false and (mimeType = 'application/pgp-encrypted' or mimeType = 'application/pgp' or mimeType = 'application/pgp-signature' or mimeType = 'application/gpg-signature' or mimeType = 'application/gpg' or mimeType = 'application/gpg-encrypted')`;
          const loginResponse = await fetch(
              `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(loginQuery)}`, {
                method: 'GET',
                headers: new Headers({
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
                })
              })
            .then(handleStatus);
          const passFiles = await loginResponse.json();
          for (const passFile of passFiles.files) {
            const loginId = passFile.id;
            const username = passFile.name.substring(0, passFile.name
              .length - 4);
            logins.push({
              username,
              loginId,
              domainPrefix,
              domainSuffix,
              faviconUrl
            });
          }
        }));
      }));
    } catch (error) {
      showMessage('Failed to fetch logins from Google Drive.');
      logError(error);
      return;
    }
    // Sort logins first by decreasing length of domain prefix, then by
    // username and as a last resort by Google Drive ID. This maintains a
    // deterministic ordering of the logins even though we fetch them
    // asynchronously.
    logins.sort(function(a, b) {
      if (a.domainPrefix.length !== b.domainPrefix.length)
        return a.domainPrefix.length - b.domainPrefix.length;

      if (a.username !== b.username)
        return a.username.localeCompare(b.username);

      return a.loginId.localeCompare(b.loginId);
    });
    AppState.currentLogins = logins;
    AppState.state = State.SHOWING_LOGINS;
  }

  async function copyToClipboard(text) {
    document.addEventListener('copy', function(event) {
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    });
    // TODO: Find out why the setTimeout is necessary. The event listener is
    // never called if we don't use it.
    setTimeout(() => document.execCommand('copy'), 1);

    chrome.alarms.create('clearClipboard', {delayInMinutes: 1});
    showMessage(`Password copied to clipboard for 60s.`);
  }

  async function fillLoginForm(username, password) {
    // Do not send login data to page if URL changed during search.
    if (AppState.activeTab.url !== AppState.currentUrl) {
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
          && el.getClientRects().length > 0;
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

      function fields(selector) {
        const fields = formOrFieldset().querySelectorAll(selector);
        if (fields.length > 0)
          return fields;
        else
          return form().querySelectorAll(selector);
      }

      function field(selector) {
        return fields(selector)[0] || document.createElement('input');
      }

      function update(el, value) {
        if (!value.length)
          return false;
        el.value = value;
        const eventNames = ['click', 'focus', 'keyup', 'keydown', 'change', 'blur', 'input'];
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
      else {
        let submitButton = document.createElement('button');
        if (fields('[type=submit]').length === 1) {
          submitButton = field('[type=submit]');
        } else if (fields('button').length === 1) {
          submitButton = field('button');
        }
        // Wait for events triggered by simulated user input to settle
        setTimeout(() => submitButton.click(), 100);
      }
    })();
    `;
    // Some login forms are not part of the top frame. This makes it necessary
    // to inject the autofill code into all frames and use the first visible
    // password field. Being able to set allFrames to true is all we need the
    // http(s)://*/* permission for.
    await chromep.tabs.executeScript({
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
      this.supportsChaining = false;
      this.supportsExtendedLength = false;
    }

    get readerShort() {
      if (this.reader.includes('Yubikey NEO-N'))
        return 'Yubikey NEO-N';
      else if (this.reader.includes('Yubikey NEO'))
        return 'YubiKey NEO';
      else if (this.reader.includes('Yubikey 4'))
        return 'YubiKey 4';
      else if (this.reader.includes('Nitrokey Start'))
        return 'Nitrokey Start';
      else if (this.reader.includes('Nitrokey Pro'))
        return 'Nitrokey Pro';
      else if (this.reader.includes('Nitrokey Storage'))
        return 'Nitrokey Storage';
      else if (this.reader.includes('Gemalto USB Shell Token'))
        return 'Gemalto Shell Token';
      else if (this.reader.includes('Gemalto PC Twin Reader'))
        return 'Gemalto Twin Reader';
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
        for (const command of commandAPDU.commands(
          this.supportsChaining, this.supportsExtendedLength)) {
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
        await determineOpenPGPCardCapabilities();
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
    constructor(
      cla, ins, p1, p2, data = new Uint8Array([]), expectResponse = true) {
       this.header = new Uint8Array([cla, ins, p1, p2]);
       this.data = data;
       this.expectResponse = expectResponse;
    }

    commands(supportsChaining, supportsExtendedLength) {
      const MAX_LC = 255;
      const MAX_EXTENDED_LC = 65535;

      if (this.data.length === 0 && supportsExtendedLength) {
          const extendedLe = this.expectResponse ?
              new Uint8Array([0x00, 0x00, 0x00]) : new Uint8Array([]);
          return [util.concatUint8Array([this.header, extendedLe])];
      }
      if (this.data.length === 0) {
        const le = this.expectResponse ?
            new Uint8Array([0x00]) : new Uint8Array([]);
        return [util.concatUint8Array([this.header, le])];
      }
      if (this.data.length <= MAX_EXTENDED_LC && supportsExtendedLength) {
        const extendedLc = new Uint8Array(
            [0x00, this.data.length >> 8, this.data.length & 0xFF]);
        const extendedLe = this.expectResponse ?
            new Uint8Array([0x00, 0x00]) : new Uint8Array([]);
        return [
          util.concatUint8Array(
            [this.header, extendedLc, this.data, extendedLe]),
        ];
      }
      if (this.data.length <= MAX_LC || supportsChaining) {
        let commands = [];
        let remainingBytes = this.data.length;
        while (remainingBytes > MAX_LC) {
          let header = new Uint8Array(this.header);
          // Set continuation bit in CLA byte.
          header[0] |= 1 << 4;
          const lc = new Uint8Array([MAX_LC]);
          const data = this.data.subarray(
              this.data.length - remainingBytes,
              this.data.length - remainingBytes + MAX_LC);
          const le =
              this.expectResponse ?
              new Uint8Array([0x00]) : new Uint8Array([]);
          commands.push(util.concatUint8Array([header, lc, data, le]));
          remainingBytes -= MAX_LC;
        }
        const lc = new Uint8Array([remainingBytes]);
        const data = this.data.subarray(this.data.length - remainingBytes);
        const le =
            this.expectResponse ? new Uint8Array([0x00]) : new Uint8Array([]);
        commands.push(util.concatUint8Array([this.header, lc, data, le]));
        return commands;
      }
      throw new Error(
          `CommandAPDU.commands: data field too long (${this.data.length} ` +
          ` > ${MAX_LC}) and no support for chaining`);
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

    static fromBytesInRange(bytes, start = 0, end = bytes.length) {
      let pos = start;
      // Skip 0x00 and 0xFF bytes before and between tags.
      while (pos < end && (bytes[pos] === 0x00 || bytes[pos] === 0xFF)) {
        ++pos;
      }
      if (pos >= end) {
        return [null, start];
      }

        const dataObject = new DataObject();
        const tagByte = bytes[pos++];
        dataObject.tagClass = tagByte >>> 6;
      dataObject.tagClassDescription =
        DATA_OBJECT_TAG_CLASS[dataObject.tagClass];
        const isConstructed = !!(tagByte & (1 << 5));
        dataObject.isConstructed = isConstructed;

        let tagNumber = tagByte & 0b00011111;
        let numTagNumberBytes = 1;
        if (tagNumber === 0b00011111) {
        if (!(bytes[pos] & 0b01111111)) {
          throw new Error(
              'DataObject.fromBytesInRange: first byte of the tag number is 0');
        }
          tagNumber = 0;
          do {
            tagNumber = (tagNumber << 7) + (bytes[pos] & 0b01111111);
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
            let child;
        do {
          [child, pos] = DataObject.fromBytesInRange(bytes, pos, valueEnd);
          if (child) {
            dataObject.children.push(child);
          }
        } while (child);
        } else {
          dataObject.value = value;
        }
        return [dataObject, valueEnd];
    }

    static fromBytes(bytes) {
      let dataObjects = [];
      let pos = 0;
      let dataObject;
      do {
        [dataObject, pos] = DataObject.fromBytesInRange(bytes, pos);
        if (dataObject) {
          dataObjects.push(dataObject);
        }
      } while(dataObject);

      if (dataObjects.length === 0) {
        return null;
      }
      if (dataObjects.length === 1) {
        return dataObjects[0];
      }

      // Create an artificial root object under which all tags of a top-level
      // tag list are subsumed. This ensures a consistent structure of replies
      // to GET DATA command among different smart card brands.
      const artificialRootObject = new DataObject();
      artificialRootObject.isConstructed = true;
      artificialRootObject.children = dataObjects;
      return artificialRootObject;
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
      );
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
        pgpMessage = await openpgp.message.read(encryptedPassword);
      } catch (_) {
        try {
          pgpMessage = await openpgp.message.readArmored(util.Uint8Array_to_str(
            encryptedPassword));
        } catch (error) {
          showMessage('Encrypted file is malformed.');
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
      const checksum = decryptedSessionKey.subarray(-2);
      const data = decryptedSessionKey.subarray(1, decryptedSessionKey.length -
        2);
      if (!util.equalsUint8Array(checksum, util.write_checksum(data))) {
        showMessage('Checksum mismatch, encrypted file is malformed.');
        return;
      }
      const sessionKey = {
        data,
        algorithm: openpgp.enums.read(openpgp.enums.symmetric,
          symmetricAlgorithm)
      };
      const decryptedMessage = await pgpMessage.decrypt(
        /* privateKeys */ null,
        /* passwords */ null,
        [sessionKey]
      );
      let passwordStream;
      if (decryptedMessage.packets[0].tag === openpgp.enums.packet.compressed)
        passwordStream = decryptedMessage.packets[0].packets[0].data;
      else
        passwordStream = decryptedMessage.packets[0].data;

      let password = util.Uint8Array_to_str(await openpgp.stream.readToEnd(passwordStream));
      // Remove trailing carriage returns and line feeds
      password = password.replace(/[\n\r]+$/g, '');

      if (copy) {
        await copyToClipboard(password);
      } else {
        await fillLoginForm(login.username, password);
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

  async function determineOpenPGPCardCapabilities() {
    const historicalBytes = await manager.transmit(
      new CommandAPDU(0x00, 0xCA, 0x5F, 0x52)
    );
    // Parse data objects in COMPACT-TLV.
    // First byte is assumed to be 0x00, last three bytes are status bytes.
    const compactTLVData = historicalBytes.slice(1, -3);
    let pos = 0;
    let capabilitiesBytes = null;
    while (pos < compactTLVData.length) {
      const tag = compactTLVData[pos];
      if (tag === 0x73) {
        capabilitiesBytes = compactTLVData.slice(pos + 1, pos + 4);
        break;
      } else {
        // The length of the tag is encoded in the second nibble.
        pos += 1 + (tag & 0x0F);
      }
    }

    if (capabilitiesBytes) {
      manager.supportsChaining = capabilitiesBytes[2] & (1 << 7);
      manager.supportsExtendedLength = capabilitiesBytes[2] & (1 << 6);
    } else {
      console.error(
          'SmartCardManager.determineOpenPGPCardCapabilities: ' +
          'capabilities tag not found');
    }
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
    const pinBytes = util.encode_utf8(pin);
    // Verify PIN for decryption
    try {
      await manager.transmit(new CommandAPDU(0x00, 0x20, 0x00, 0x82, pinBytes,    false));
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
    AppState.fingerprint = util.Uint8Array_to_hex(publicKeyId.slice(4)).toUpperCase();
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
