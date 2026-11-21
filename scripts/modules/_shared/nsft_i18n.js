/*
 * NSFT · Seletor de idioma da interface.
 *
 * O chrome.i18n nativo segue sempre o idioma do navegador. Este shim permite
 * escolher o idioma da extensão (Automático / Português / English / Español)
 * sem tocar nas ~2000 chamadas a chrome.i18n.getMessage espalhadas no código:
 * ele substitui getMessage/getUILanguage e lê o messages.json do idioma
 * escolhido.
 *
 * Funciona em três contextos:
 *  - Páginas da extensão (popup, sidepanel, welcome...): carga síncrona.
 *  - Content scripts (mundo isolado): carga síncrona via WAR.
 *  - Service worker: carga assíncrona (fetch) ao iniciar.
 *
 * A escolha fica em chrome.storage.local.nsftUiLang e é espelhada em
 * localStorage (chave nsft_ui_lang) para poder ser lida de forma síncrona
 * no carregamento da página.
 */
(function () {
    'use strict';
    const G = typeof globalThis !== 'undefined' ? globalThis : self;
    if (G.__nsftI18nInstalled) return;
    G.__nsftI18nInstalled = true;

    const C = G.chrome;
    if (!C || !C.i18n || typeof C.i18n.getMessage !== 'function') return;

    const STORAGE_KEY = 'nsftUiLang';
    const LS_KEY = 'nsft_ui_lang';
    const SUPPORTED = ['pt_BR', 'en', 'es'];
    const UI_TAGS = { pt_BR: 'pt-BR', en: 'en', es: 'es' };
    const DEFAULT_LOCALE = 'en';

    const nativeGet = C.i18n.getMessage.bind(C.i18n);
    const nativeUi = (typeof C.i18n.getUILanguage === 'function') ? C.i18n.getUILanguage.bind(C.i18n) : () => 'en';

    const hasDom = typeof XMLHttpRequest !== 'undefined';
    const cache = {};

    function normalize(v) {
        if (!v || v === 'auto') return 'auto';
        const s = String(v).replace('-', '_');
        if (/^pt/i.test(s)) return 'pt_BR';
        if (/^es/i.test(s)) return 'es';
        if (/^en/i.test(s)) return 'en';
        return 'auto';
    }

    function readLocal() {
        try { return normalize(G.localStorage && G.localStorage.getItem(LS_KEY)); } catch (e) { return 'auto'; }
    }
    function writeLocal(v) {
        try { if (G.localStorage) G.localStorage.setItem(LS_KEY, v); } catch (e) { }
    }

    let current = hasDom ? readLocal() : 'auto';

    function url(loc) {
        return C.runtime.getURL('_locales/' + loc + '/messages.json');
    }

    function parse(txt) {
        const raw = JSON.parse(txt);
        const out = {};
        for (const k in raw) out[k.toLowerCase()] = raw[k];
        return out;
    }

    function loadSync(loc) {
        if (cache[loc] !== undefined) return cache[loc];
        cache[loc] = null;
        if (!hasDom) return null;
        try {
            const x = new XMLHttpRequest();
            x.open('GET', url(loc), false);
            x.send(null);
            if ((x.status === 200 || x.status === 0) && x.responseText) cache[loc] = parse(x.responseText);
        } catch (e) { cache[loc] = null; }
        return cache[loc];
    }

    async function loadAsync(loc) {
        if (cache[loc]) return cache[loc];
        try {
            const r = await fetch(url(loc));
            if (r.ok) cache[loc] = parse(await r.text());
        } catch (e) { }
        return cache[loc] || null;
    }

    function dict(loc) {
        if (cache[loc] !== undefined) return cache[loc];
        return loadSync(loc);
    }

    function format(entry, subs) {
        let msg = String(entry.message == null ? '' : entry.message);
        const ph = entry.placeholders || null;
        let list = subs;
        if (list == null) list = [];
        else if (!Array.isArray(list)) list = [list];
        list = list.map((s) => (s == null ? '' : String(s)));

        if (ph) {
            const phl = {};
            for (const k in ph) phl[k.toLowerCase()] = ph[k];
            msg = msg.replace(/\$([A-Za-z0-9_@]+)\$/g, (m, name) => {
                const p = phl[name.toLowerCase()];
                return p ? String(p.content == null ? '' : p.content) : m;
            });
        }
        msg = msg.replace(/\$(\$|[1-9])/g, (m, d) => {
            if (d === '$') return '$';
            const i = +d - 1;
            return i < list.length ? list[i] : '';
        });
        return msg;
    }

    function getMessage(key, subs) {
        if (current === 'auto' || key == null) return nativeGet(key, subs);
        const k = String(key);
        if (k.startsWith('@@')) return nativeGet(key, subs);
        const lk = k.toLowerCase();
        const d = dict(current);
        if (d && d[lk]) return format(d[lk], subs);
        if (current !== DEFAULT_LOCALE) {
            const f = dict(DEFAULT_LOCALE);
            if (f && f[lk]) return format(f[lk], subs);
        }
        return nativeGet(key, subs);
    }

    function getUILanguage() {
        if (current === 'auto') return nativeUi();
        return UI_TAGS[current] || nativeUi();
    }

    function install(target) {
        try {
            Object.defineProperty(target, 'getMessage', { value: getMessage, configurable: true, writable: true });
            Object.defineProperty(target, 'getUILanguage', { value: getUILanguage, configurable: true, writable: true });
            return target.getMessage === getMessage;
        } catch (e) {
            try { target.getMessage = getMessage; target.getUILanguage = getUILanguage; } catch (e2) { }
            return target.getMessage === getMessage;
        }
    }

    if (!install(C.i18n)) {
        try {
            const wrapped = Object.assign({}, C.i18n, { getMessage, getUILanguage });
            Object.defineProperty(C, 'i18n', { value: wrapped, configurable: true, writable: true });
        } catch (e) { }
    }
    if (G.browser && G.browser.i18n && G.browser.i18n !== C.i18n) install(G.browser.i18n);

    function setCurrent(v) {
        const n = normalize(v);
        if (hasDom) writeLocal(n);
        if (n === current) return;
        current = n;
        if (!hasDom && n !== 'auto') { loadAsync(n); if (n !== DEFAULT_LOCALE) loadAsync(DEFAULT_LOCALE); }
        try { G.dispatchEvent && G.dispatchEvent(new CustomEvent('nsft-ui-lang-changed', { detail: n })); } catch (e) { }
    }

    // No service worker não há leitura síncrona: começa com o nativo e troca
    // assim que o storage responder.
    try {
        C.storage && C.storage.local.get({ [STORAGE_KEY]: 'auto' }, (it) => {
            if (C.runtime.lastError) return;
            setCurrent(it && it[STORAGE_KEY]);
        });
        C.storage && C.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[STORAGE_KEY]) setCurrent(changes[STORAGE_KEY].newValue);
        });
    } catch (e) { }

    G.NSFT_I18N = {
        STORAGE_KEY,
        SUPPORTED,
        get current() { return current; },
        /** Idioma efetivo ('pt_BR' | 'en' | 'es'), resolvendo 'auto'. */
        effective() {
            if (current !== 'auto') return current;
            const n = normalize(nativeUi());
            return n === 'auto' ? DEFAULT_LOCALE : n;
        },
        /** Grava a escolha (auto | pt_BR | en | es). */
        set(v) {
            const n = normalize(v);
            if (hasDom) writeLocal(n);
            return new Promise((res) => {
                try { C.storage.local.set({ [STORAGE_KEY]: n }, () => res(n)); } catch (e) { res(n); }
            });
        },
        t: getMessage,
    };
})();
