/*
 * NSFT · Relatório de implementações de script.
 *
 * Uma janela com TODAS as implementações de script da conta e, para cada uma:
 *  - Criado por: quem mexeu primeiro (notas do sistema da implementação; se ela
 *    não tiver notas, as do script; por último, o Proprietário do script);
 *  - Alterado por: quem mexeu por último;
 *  - Proprietário: o campo Proprietário do registro do script.
 * Filtro de usuário com digitação e sugestões ("leo" → LEONARDO CASSIANO…),
 * mais tipo, status, implementado e busca livre; colunas ordenáveis, links
 * diretos e exportação para CSV.
 *
 * Abre pelo botão nas páginas Implementações de script / Scripts, pelo menu
 * Ferramentas e pela Paleta de comandos (evento nsft-show-deployment-report).
 */
(function () {
    'use strict';
    if (window.__nsftDeplRep) return;
    window.__nsftDeplRep = true;
    if (window.NSFT_Herramientas && window.NSFT_Herramientas.vigila) {
        try { window.NSFT_Herramientas.vigila('.nsft-deplrep-overlay', 'deplrep'); } catch (e) { }
    }

    const STORAGE_KEY = 'enableDeploymentReport';
    const MODAL_ID = 'nsft-deplrep';
    const LAUNCH_ID = 'nsft-deplrep-launch';
    const FILTERS_KEY = 'nsft_deplrep_filters_v2';
    const MAX_RENDER = 3000;

    const t = (k, subs, fb) => {
        try { const m = chrome.i18n.getMessage(k, subs); if (m) return m; } catch (e) { }
        return fb || k;
    };

    const TYPE_LABELS = {
        USEREVENT: 'User Event', CLIENT: 'Client', SCRIPTLET: 'Suitelet', RESTLET: 'RESTlet',
        MAPREDUCE: 'Map/Reduce', SCHEDULED: 'Scheduled', ACTION: 'Workflow Action',
        MASSUPDATE: 'Mass Update', PORTLET: 'Portlet', BUNDLEINSTALLATION: 'Bundle Installation',
        SDFINSTALLATION: 'SDF Installation', EMAILCAPTURE: 'Email Capture', PLUGINTYPE: 'Plug-in',
        CUSTOMGLLINES: 'Custom GL Lines', CONSOLRATEADJUSTOR: 'Consolidated Rate Adjustor',
        WEBAPP: 'Web App', PAYMENTGATEWAY: 'Payment Gateway',
        SPASERVERSCRIPT: 'SPA Server Script', CUSTOMTOOL: 'Custom Tool'
    };
    const STATUS_KEYS = {
        RELEASED: 'fcds_status_released', TESTING: 'fcds_status_testing',
        NOTSCHEDULED: 'fcds_status_notscheduled', SCHEDULED: 'fcds_status_scheduled'
    };

    let enabled = true;
    let rows = null;
    let users = [];            // [{ id, name, created, touched, owner }]
    let notesInfo = { ok: false, error: '' };
    let expectedTotal = null;
    let loadingPromise = null;
    let sort = { col: 'createdDate', dir: -1 };
    let filters = readFilters();

    /* ---------- liga/desliga ---------- */

    chrome.storage.local.get({ [STORAGE_KEY]: true }, (it) => {
        enabled = !!it[STORAGE_KEY];
        if (enabled) addLaunchButton();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local' || !ch[STORAGE_KEY]) return;
        enabled = !!ch[STORAGE_KEY].newValue;
        if (enabled) addLaunchButton();
        else { const b = document.getElementById(LAUNCH_ID); if (b) b.remove(); close(); }
    });

    window.addEventListener('nsft-show-deployment-report', () => { if (enabled) open(); });

    /* ---------- botão nas páginas de scripts ---------- */

    function isScriptListPage() {
        return /\/app\/common\/scripting\/(scriptrecordlist|scriptlist)\.nl/i.test(location.pathname);
    }

    function addLaunchButton() {
        if (!isScriptListPage() || document.getElementById(LAUNCH_ID)) return;
        const tryAdd = () => {
            if (document.getElementById(LAUNCH_ID)) return true;
            const title = document.querySelector('.uir-page-title-firstline h1, .uir-page-title h1, h1.uir-record-type, #pagetitle h1, .uir-page-title-firstline');
            const btn = document.createElement('a');
            btn.id = LAUNCH_ID;
            btn.href = '#';
            btn.className = 'nsft-pastilla nsft-deplrep-launch';
            btn.innerHTML = icon() + '<span></span>';
            btn.querySelector('span').textContent = t('dr_title', null, 'Script deployments report');
            btn.title = t('dr_launch_tip', null, 'Filter every deployment by user, type and status');
            btn.addEventListener('click', (e) => { e.preventDefault(); open(); });
            if (title) { title.insertAdjacentElement('afterend', btn); return true; }
            if (document.body) { btn.classList.add('is-floating'); document.body.appendChild(btn); return true; }
            return false;
        };
        if (!tryAdd()) document.addEventListener('DOMContentLoaded', tryAdd, { once: true });
    }

    /* ---------- dados ---------- */

    function ensureFetcher() {
        return new Promise((resolve) => {
            if (window.__nsftDeplRepFetcherInjected) { resolve(); return; }
            window.__nsftDeplRepFetcherInjected = true;
            try { window.NSFT_SuiteQLRest && window.NSFT_SuiteQLRest.ensureTransport(); } catch (e) { }
            const s = document.createElement('script');
            s.async = false;
            s.src = chrome.runtime.getURL('scripts/modules/deployment_report/deployment_report_fetcher.js');
            s.onload = function () { this.remove(); resolve(); };
            s.onerror = function () { this.remove(); resolve(); };
            (window.NSFT_AfterLoad ? window.NSFT_AfterLoad.append(s) : (document.head || document.documentElement).appendChild(s));
        });
    }

    function isTrue(v) {
        return v === true || /^(t|true|y|yes|s|sim|1)$/i.test(String(v == null ? '' : v).trim());
    }

    function isNone(name) {
        return !name || /^-\s*(none|nenhum|ninguno|ninguna)\s*-$/i.test(String(name).trim());
    }

    // Agrupa as notas por chave: { key: { first:{uid,uname,date}, last:{...}, people: Map(uid→uname) } }
    function indexNotes(list) {
        const map = new Map();
        (list || []).forEach((n) => {
            if (isNone(n.uname)) return;
            const k = String(n.key).toUpperCase();
            let e = map.get(k);
            if (!e) { e = { first: null, last: null, people: new Map() }; map.set(k, e); }
            e.people.set(n.uid || n.uname, n.uname);
            if (n.first && (!e.first || n.first < e.first.date)) e.first = { uid: n.uid, uname: n.uname, date: n.first };
            if (n.last && (!e.last || n.last > e.last.date)) e.last = { uid: n.uid, uname: n.uname, date: n.last };
        });
        return map;
    }

    function build(result) {
        const notes = result.notes || {};
        expectedTotal = result.expected;
        notesInfo = { ok: !notes.error || (notes.deployments || []).length > 0, error: notes.error || '' };
        const byDep = indexNotes(notes.deployments);
        const byScript = indexNotes(notes.scripts);

        rows = (result.rows || []).map((r) => {
            const type = String(r.stype || '').toUpperCase();
            const status = String(r.dstatus || '').toUpperCase();
            const ownerName = r.ownname || (r.ownid ? '#' + r.ownid : '');
            const dn = byDep.get(String(r.did));
            const sn = byScript.get(String(r.sid));
            let created = null, createdFrom = '';
            if (dn && dn.first) { created = dn.first; createdFrom = 'dep'; }
            else if (sn && sn.first) { created = sn.first; createdFrom = 'script'; }
            else if (ownerName && String(r.ownid) !== '-5') { created = { uid: String(r.ownid), uname: ownerName, date: '' }; createdFrom = 'owner'; }
            const modified = (dn && dn.last) || (sn && sn.last) || null;
            const people = new Map();
            if (dn) dn.people.forEach((v, k) => people.set(k, v));
            if (sn) sn.people.forEach((v, k) => people.set(k, v));
            if (r.ownid != null && ownerName) people.set(String(r.ownid), ownerName);
            return {
                did: String(r.did), dcode: r.dcode || '', dtitle: r.dtitle || r.dcode || '',
                on: isTrue(r.don), status,
                statusLabel: STATUS_KEYS[status] ? t(STATUS_KEYS[status], null, status) : (r.dstatus || ''),
                rec: r.drec || '',
                sid: String(r.sid), scode: r.scode || '', sname: r.sname || r.scode || '',
                type, typeLabel: TYPE_LABELS[type] || r.stype || '',
                ownid: r.ownid == null ? '' : String(r.ownid), owner: ownerName,
                createdId: created ? String(created.uid || created.uname) : '',
                createdBy: created ? created.uname : '',
                createdDate: created ? created.date : '',
                createdFrom,
                modifiedBy: modified ? modified.uname : '',
                modifiedId: modified ? String(modified.uid || modified.uname) : '',
                modifiedDate: modified ? modified.date : '',
                people,
                sinactive: isTrue(r.sinactive),
                fid: r.fid == null ? '' : String(r.fid), fname: r.fname || ''
            };
        });

        // Índice de usuários para as sugestões.
        const idx = new Map();
        const bump = (id, name, field) => {
            if (!name) return;
            const k = String(id || name);
            const u = idx.get(k) || { id: k, name, created: 0, touched: 0, owner: 0 };
            u[field]++; idx.set(k, u);
        };
        rows.forEach((r) => {
            if (r.createdBy) bump(r.createdId, r.createdBy, 'created');
            r.people.forEach((name, id) => bump(id, name, 'touched'));
            if (r.owner) bump(r.ownid, r.owner, 'owner');
        });
        users = Array.from(idx.values()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    function load(force) {
        if (rows && !force) return Promise.resolve(rows);
        if (loadingPromise) return loadingPromise;
        loadingPromise = (async () => {
            await ensureFetcher();
            const requestId = 'dr_' + Date.now();
            const result = await new Promise((resolve) => {
                const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ error: 'timeout' }); }, 240000);
                function onMsg(ev) {
                    if (ev.source !== window) return;
                    const d = ev.data;
                    if (!d || d.dest !== 'extension_deplrep' || d.requestId !== requestId) return;
                    if (d.type === 'progress') {
                        setStatus(d.step === 'notes'
                            ? t('dr_loading_notes', [String(d.count)], d.count + ' deployments · reading system notes…')
                            : t('dr_loading_n', [String(d.count)], 'Loading deployments… ' + d.count));
                        return;
                    }
                    clearTimeout(timer);
                    window.removeEventListener('message', onMsg);
                    resolve(d);
                }
                window.addEventListener('message', onMsg);
                window.postMessage({ dest: 'fetcher_deplrep', type: 'load', requestId }, '*');
            });
            loadingPromise = null;
            if (result.error) throw new Error(result.error);
            build(result);
            return rows;
        })();
        return loadingPromise;
    }

    /* ---------- filtros ---------- */

    function emptyFilters() {
        return { q: '', userId: '', userText: '', scope: 'created', type: '', status: '', deployed: '' };
    }
    function readFilters() {
        try { return Object.assign(emptyFilters(), JSON.parse(sessionStorage.getItem(FILTERS_KEY) || '{}')); } catch (e) { return emptyFilters(); }
    }
    function saveFilters() {
        try { sessionStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch (e) { }
    }

    function norm(s) {
        return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    }

    // O usuário corresponde se o texto aparece no início de alguma palavra do nome
    // (ou em qualquer parte, se não houver correspondência no início).
    function nameMatches(name, text) {
        const n = norm(name), q = norm(text);
        if (!q) return true;
        if (n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q))) return true;
        return n.includes(q);
    }

    function rowMatchesUser(r) {
        const scope = filters.scope;
        if (filters.userId) {
            if (scope === 'created') return r.createdId === filters.userId;
            if (scope === 'modified') return r.modifiedId === filters.userId;
            if (scope === 'owner') return r.ownid === filters.userId;
            return r.people.has(filters.userId) || r.createdId === filters.userId;
        }
        if (!filters.userText) return true;
        const txt = filters.userText;
        if (scope === 'created') return nameMatches(r.createdBy, txt);
        if (scope === 'modified') return nameMatches(r.modifiedBy, txt);
        if (scope === 'owner') return nameMatches(r.owner, txt);
        if (nameMatches(r.createdBy, txt)) return true;
        for (const name of r.people.values()) if (nameMatches(name, txt)) return true;
        return false;
    }

    function filtered() {
        const words = norm(filters.q).split(/\s+/).filter(Boolean);
        const out = rows.filter((r) => {
            if (!rowMatchesUser(r)) return false;
            if (filters.type && r.type !== filters.type) return false;
            if (filters.status && r.status !== filters.status) return false;
            if (filters.deployed === 'T' && !r.on) return false;
            if (filters.deployed === 'F' && r.on) return false;
            if (words.length) {
                const hay = norm([r.did, r.dcode, r.dtitle, r.sname, r.scode, r.owner, r.createdBy, r.modifiedBy, r.typeLabel, r.rec, r.fname].join(' '));
                if (!words.every((w) => hay.includes(w))) return false;
            }
            return true;
        });
        const c = sort.col, dir = sort.dir;
        out.sort((a, b) => {
            if (c === 'did') return (+a.did - +b.did) * dir;
            if (c === 'on') return ((a.on ? 1 : 0) - (b.on ? 1 : 0)) * dir;
            const x = String(a[c] || ''), y = String(b[c] || '');
            if (!x && y) return 1;      // vazios sempre no fim
            if (x && !y) return -1;
            return x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true }) * dir;
        });
        return out;
    }

    /* ---------- janela ---------- */

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fmtDate(iso) {
        if (!iso) return '';
        const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(iso);
        if (!m) return iso;
        try {
            const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
            return d.toLocaleDateString(chrome.i18n.getUILanguage()) + (m[4] ? ' ' + m[4] + ':' + m[5] : '');
        } catch (e) { return iso; }
    }

    function setStatus(txt) {
        const s = document.querySelector('#' + MODAL_ID + ' .nsft-deplrep-status');
        if (s) s.textContent = txt;
    }

    function close() {
        const m = document.getElementById(MODAL_ID);
        if (m) m.remove();
        document.removeEventListener('keydown', onKey, true);
    }

    function onKey(e) {
        if (e.key !== 'Escape') return;
        const sug = document.querySelector('#' + MODAL_ID + ' .nsft-deplrep-sug:not([hidden])');
        e.stopPropagation();
        if (sug) { sug.hidden = true; return; }
        close();
    }

    const COLUMNS = [
        { col: 'did', label: () => t('dr_col_id', null, 'Internal ID') },
        { col: 'dtitle', label: () => t('dr_col_deployment', null, 'Deployment') },
        { col: 'sname', label: () => t('dr_col_script', null, 'Script') },
        { col: 'typeLabel', label: () => t('dr_col_type', null, 'Type') },
        { col: 'createdBy', label: () => t('dr_col_created', null, 'Created by') },
        { col: 'modifiedBy', label: () => t('dr_col_modified', null, 'Last changed by') },
        { col: 'owner', label: () => t('dr_col_owner', null, 'Script owner') },
        { col: 'statusLabel', label: () => t('dr_col_status', null, 'Status') },
        { col: 'on', label: () => t('dr_col_deployed', null, 'Deployed') },
        { col: 'rec', label: () => t('dr_col_record', null, 'Applied to') },
        { col: 'fname', label: () => t('dr_col_file', null, 'File') }
    ];

    function open() {
        if (document.getElementById(MODAL_ID)) return;
        const wrap = el('div', 'nsft-deplrep-overlay');
        wrap.id = MODAL_ID;
        wrap.innerHTML = `
            <div class="nsft-deplrep-box" role="dialog" aria-modal="true">
              <div class="nsft-deplrep-head">
                <span class="nsft-deplrep-ico">${icon()}</span>
                <strong>${esc(t('dr_title', null, 'Script deployments report'))}</strong>
                <span class="nsft-deplrep-status"></span>
                <span class="nsft-deplrep-spacer"></span>
                <button type="button" class="nsft-deplrep-btn" data-a="reload">${esc(t('dr_reload', null, 'Reload'))}</button>
                <button type="button" class="nsft-deplrep-btn" data-a="csv">${esc(t('dr_export_csv', null, 'Export CSV'))}</button>
                <button type="button" class="nsft-deplrep-x" data-a="close" title="${esc(t('fcds_close', null, 'Close'))}">×</button>
              </div>
              <div class="nsft-deplrep-filters">
                <label class="is-user"><span>${esc(t('dr_f_user', null, 'User'))}</span>
                  <span class="nsft-deplrep-userbox">
                    <input type="text" data-user autocomplete="off" spellcheck="false" placeholder="${esc(t('dr_f_user_ph', null, 'Type a name, e.g. leo'))}">
                    <button type="button" class="nsft-deplrep-userclear" data-a="userclear" title="${esc(t('dr_clear', null, 'Clear'))}" hidden>×</button>
                    <div class="nsft-deplrep-sug" role="listbox" hidden></div>
                  </span></label>
                <label><span>${esc(t('dr_f_scope', null, 'Look in'))}</span><select data-f="scope">
                  <option value="created">${esc(t('dr_col_created', null, 'Created by'))}</option>
                  <option value="any">${esc(t('dr_scope_any', null, 'Anyone who changed it'))}</option>
                  <option value="modified">${esc(t('dr_col_modified', null, 'Last changed by'))}</option>
                  <option value="owner">${esc(t('dr_col_owner', null, 'Script owner'))}</option>
                </select></label>
                <label class="is-wide"><span>${esc(t('dr_f_search', null, 'Search'))}</span>
                  <input type="search" data-f="q" placeholder="${esc(t('dr_f_search_ph', null, 'Deployment, script, ID, file…'))}"></label>
                <label><span>${esc(t('dr_col_type', null, 'Type'))}</span><select data-f="type"></select></label>
                <label><span>${esc(t('dr_col_status', null, 'Status'))}</span><select data-f="status"></select></label>
                <label><span>${esc(t('dr_col_deployed', null, 'Deployed'))}</span><select data-f="deployed">
                  <option value="">${esc(t('dr_all', null, '- All -'))}</option>
                  <option value="T">${esc(t('fcds_dep_on', null, 'Deployed'))}</option>
                  <option value="F">${esc(t('fcds_dep_off', null, 'Not deployed'))}</option>
                </select></label>
                <button type="button" class="nsft-deplrep-btn is-ghost" data-a="clear">${esc(t('dr_clear', null, 'Clear filters'))}</button>
              </div>
              <div class="nsft-deplrep-owners"></div>
              <div class="nsft-deplrep-notice" hidden></div>
              <div class="nsft-deplrep-tablewrap">
                <table class="nsft-deplrep-table"><thead><tr></tr></thead><tbody></tbody></table>
                <div class="nsft-deplrep-empty" hidden></div>
              </div>
              <div class="nsft-deplrep-foot"></div>
            </div>`;
        document.body.appendChild(wrap);
        document.addEventListener('keydown', onKey, true);

        wrap.addEventListener('mousedown', (e) => {
            if (e.target === wrap) close();
            if (!e.target.closest('.nsft-deplrep-userbox')) hideSug();
        });
        wrap.querySelector('[data-a="close"]').addEventListener('click', close);
        wrap.querySelector('[data-a="reload"]').addEventListener('click', () => start(true));
        wrap.querySelector('[data-a="csv"]').addEventListener('click', exportCsv);
        wrap.querySelector('[data-a="clear"]').addEventListener('click', () => {
            filters = emptyFilters(); saveFilters(); syncInputs(); render();
        });
        wrap.querySelector('[data-a="userclear"]').addEventListener('click', () => {
            filters.userId = ''; filters.userText = ''; saveFilters(); syncInputs(); render();
            wrap.querySelector('[data-user]').focus();
        });
        wrap.querySelectorAll('[data-f]').forEach((inp) => {
            inp.addEventListener(inp.tagName === 'INPUT' ? 'input' : 'change', () => {
                filters[inp.dataset.f] = inp.value; saveFilters(); render();
            });
        });
        wireUserBox(wrap);

        const tr = wrap.querySelector('thead tr');
        COLUMNS.forEach((c) => {
            const th = el('th', null, c.label());
            th.dataset.col = c.col;
            th.addEventListener('click', () => {
                sort = { col: c.col, dir: sort.col === c.col ? -sort.dir : 1 };
                render();
            });
            tr.appendChild(th);
        });

        start(false);
        setTimeout(() => { const q = wrap.querySelector('[data-user]'); if (q) q.focus(); }, 50);
    }

    /* ---------- campo de usuário com sugestões ---------- */

    let sugIndex = -1;

    function hideSug() {
        const sug = document.querySelector('#' + MODAL_ID + ' .nsft-deplrep-sug');
        if (sug) sug.hidden = true;
        sugIndex = -1;
    }

    function userCount(u) {
        const s = filters.scope;
        return s === 'created' ? u.created : s === 'owner' ? u.owner : u.touched;
    }

    function involved(u) {
        return u.created > 0 || u.touched > 0 || u.owner > 0;
    }

    function showSug(wrap) {
        const inp = wrap.querySelector('[data-user]');
        const sug = wrap.querySelector('.nsft-deplrep-sug');
        const q = inp.value;
        // Mostra todo mundo que tem alguma ligação com implementações, não só quem
        // tem número no escopo atual (ex.: quem só alterou aparece mesmo em "Criado por").
        let list = users.filter((u) => involved(u) && nameMatches(u.name, q));
        const nq = norm(q);
        list.sort((a, b) => {
            const as = norm(a.name).startsWith(nq) ? 0 : 1, bs = norm(b.name).startsWith(nq) ? 0 : 1;
            return (as - bs) || (userCount(b) - userCount(a)) || a.name.localeCompare(b.name);
        });
        list = list.slice(0, 50);
        sug.innerHTML = '';
        if (!list.length) {
            sug.appendChild(el('div', 'nsft-deplrep-sug-empty', t('dr_user_none', null, 'Nobody with that name')));
        } else {
            list.forEach((u, i) => {
                const it = el('div', 'nsft-deplrep-sug-item');
                it.setAttribute('role', 'option');
                it.dataset.id = u.id;
                it.innerHTML = '<span class="nm"></span><span class="ct"></span>';
                it.querySelector('.nm').innerHTML = highlight(u.name, q);
                it.querySelector('.ct').textContent = t('dr_user_counts', [String(u.created), String(u.touched)], 'created ' + u.created + ' · changed ' + u.touched);
                it.addEventListener('mousedown', (e) => { e.preventDefault(); pickUser(wrap, u); });
                if (i === sugIndex) it.classList.add('is-active');
                sug.appendChild(it);
            });
        }
        sug.hidden = false;
    }

    function highlight(name, q) {
        const nq = norm(q);
        if (!nq) return esc(name);
        const nn = norm(name);
        let i = -1;
        const words = nn.split(/(\s+)/); let pos = 0;
        for (const w of words) { if (w.trim() && w.startsWith(nq)) { i = pos; break; } pos += w.length; }
        if (i < 0) i = nn.indexOf(nq);
        if (i < 0) return esc(name);
        return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + nq.length)) + '</mark>' + esc(name.slice(i + nq.length));
    }

    function pickUser(wrap, u) {
        if (filters.scope === 'created' && !u.created) filters.scope = 'any';
        if (filters.scope === 'owner' && !u.owner) filters.scope = 'any';
        filters.userId = u.id;
        filters.userText = u.name;
        saveFilters();
        hideSug();
        syncInputs();
        render();
    }

    function wireUserBox(wrap) {
        const inp = wrap.querySelector('[data-user]');
        inp.addEventListener('input', () => {
            filters.userId = '';            // digitando = filtro por texto (vai filtrando)
            filters.userText = inp.value;
            saveFilters();
            sugIndex = -1;
            if (rows) { showSug(wrap); render(); }
            wrap.querySelector('[data-a="userclear"]').hidden = !inp.value;
        });
        inp.addEventListener('focus', () => { if (rows) showSug(wrap); });
        inp.addEventListener('keydown', (e) => {
            const sug = wrap.querySelector('.nsft-deplrep-sug');
            const items = Array.from(sug.querySelectorAll('.nsft-deplrep-sug-item'));
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (sug.hidden) showSug(wrap);
                if (!items.length) return;
                sugIndex = e.key === 'ArrowDown' ? Math.min(items.length - 1, sugIndex + 1) : Math.max(0, sugIndex - 1);
                items.forEach((it, i) => it.classList.toggle('is-active', i === sugIndex));
                if (items[sugIndex].scrollIntoView) items[sugIndex].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const pick = items[sugIndex >= 0 ? sugIndex : 0];
                if (pick && !sug.hidden) {
                    const u = users.find((x) => x.id === pick.dataset.id);
                    if (u) pickUser(wrap, u);
                }
            }
        });
    }

    /* ---------- carregar e desenhar ---------- */

    async function start(force) {
        const box = document.getElementById(MODAL_ID);
        if (!box) return;
        box.classList.add('is-loading');
        setStatus(t('dr_loading', null, 'Loading deployments…'));
        box.querySelector('.nsft-deplrep-empty').hidden = true;
        try {
            await load(force);
            fillSelects();
            syncInputs();
            render();
        } catch (e) {
            setStatus('');
            const empty = box.querySelector('.nsft-deplrep-empty');
            empty.hidden = false;
            empty.textContent = t('dr_error', [String(e.message || e)], 'Could not load the deployments: ' + (e.message || e));
        }
        box.classList.remove('is-loading');
    }

    function fillSelects() {
        const box = document.getElementById(MODAL_ID);
        if (!box || !rows) return;
        const count = (key, labelKey) => {
            const m = new Map();
            rows.forEach((r) => {
                const k = r[key];
                const cur = m.get(k) || { label: r[labelKey] || k, n: 0 };
                cur.n++; m.set(k, cur);
            });
            return Array.from(m.entries()).sort((a, b) => String(a[1].label).localeCompare(String(b[1].label), undefined, { sensitivity: 'base' }));
        };
        const fill = (sel, entries) => {
            sel.innerHTML = '';
            sel.appendChild(new Option(t('dr_all', null, '- All -'), ''));
            entries.forEach(([k, v]) => sel.appendChild(new Option(v.label + ' (' + v.n + ')', k)));
        };
        fill(box.querySelector('[data-f="type"]'), count('type', 'typeLabel'));
        fill(box.querySelector('[data-f="status"]'), count('status', 'statusLabel'));

        // Atalhos: quem mais criou implementações.
        const chips = box.querySelector('.nsft-deplrep-owners');
        chips.innerHTML = '';
        const top = users.filter((u) => u.created > 0).sort((a, b) => b.created - a.created).slice(0, 8);
        if (top.length) {
            chips.appendChild(el('span', 'nsft-deplrep-owners-lbl', t('dr_top_creators', null, 'Created the most:')));
            top.forEach((u) => {
                const c = el('button', 'nsft-deplrep-chip', u.name + ' · ' + u.created);
                c.type = 'button';
                c.dataset.uid = u.id;
                c.addEventListener('click', () => {
                    if (filters.userId === u.id && filters.scope === 'created') { filters.userId = ''; filters.userText = ''; }
                    else { filters.userId = u.id; filters.userText = u.name; filters.scope = 'created'; }
                    saveFilters(); syncInputs(); render();
                });
                chips.appendChild(c);
            });
        }

        const notice = box.querySelector('.nsft-deplrep-notice');
        if (expectedTotal != null && rows.length < expectedTotal) {
            notice.hidden = false;
            notice.textContent = t('dr_incomplete', [String(rows.length), String(expectedTotal)],
                'Only ' + rows.length + ' of the ' + expectedTotal + ' deployments NetSuite counts were loaded. Click Reload; if it persists, report it.');
            return;
        }
        const withNotes = rows.filter((r) => r.createdFrom === 'dep' || r.createdFrom === 'script').length;
        if (!notesInfo.ok) {
            notice.hidden = false;
            notice.textContent = t('dr_notes_unavailable', null, 'System notes could not be read on this page, so "Created by" falls back to the script owner. Open the report from the Script Deployments page.');
        } else if (withNotes < rows.length) {
            notice.hidden = false;
            notice.textContent = t('dr_notes_partial', [String(rows.length - withNotes)],
                (rows.length - withNotes) + ' deployments have no system notes (common for bundles, SDF installs or a refreshed sandbox): for those, "Created by" uses the script owner or stays empty.');
        } else notice.hidden = true;
    }

    function syncInputs() {
        const box = document.getElementById(MODAL_ID);
        if (!box) return;
        box.querySelectorAll('[data-f]').forEach((inp) => {
            const v = filters[inp.dataset.f] || '';
            if (inp.tagName === 'SELECT' && v && !Array.from(inp.options).some((o) => o.value === v)) { filters[inp.dataset.f] = inp.dataset.f === 'scope' ? 'created' : ''; inp.value = filters[inp.dataset.f]; }
            else inp.value = v;
        });
        const u = box.querySelector('[data-user]');
        if (u && document.activeElement !== u) u.value = filters.userText || '';
        else if (u && filters.userId) u.value = filters.userText;
        box.querySelector('[data-a="userclear"]').hidden = !filters.userText;
        box.querySelector('.nsft-deplrep-userbox').classList.toggle('is-picked', !!filters.userId);
    }

    function render() {
        const box = document.getElementById(MODAL_ID);
        if (!box || !rows) return;
        box.querySelectorAll('.nsft-deplrep-chip').forEach((c) => c.classList.toggle('is-on', c.dataset.uid === filters.userId && filters.scope === 'created'));
        const list = filtered();
        box.querySelectorAll('th').forEach((th) => {
            th.classList.toggle('is-sorted', th.dataset.col === sort.col);
            th.dataset.dir = th.dataset.col === sort.col ? (sort.dir > 0 ? '▲' : '▼') : '';
        });
        const fromTip = {
            dep: t('dr_from_dep', null, 'From the deployment system notes'),
            script: t('dr_from_script', null, 'From the script system notes (the deployment has none)'),
            owner: t('dr_from_owner', null, 'Script owner (no system notes found)')
        };
        const body = box.querySelector('tbody');
        body.innerHTML = list.slice(0, MAX_RENDER).map((r) => `
            <tr class="${r.on ? '' : 'is-off'}${r.sinactive ? ' is-inactive' : ''}">
              <td class="is-num">${esc(r.did)}</td>
              <td><a href="/app/common/scripting/scriptrecord.nl?id=${encodeURIComponent(r.did)}" target="_blank" rel="noopener">${esc(r.dtitle)}</a><div class="nsft-deplrep-sub">${esc(r.dcode)}</div></td>
              <td><a href="/app/common/scripting/script.nl?id=${encodeURIComponent(r.sid)}" target="_blank" rel="noopener">${esc(r.sname)}</a><div class="nsft-deplrep-sub">${esc(r.scode)}</div></td>
              <td>${esc(r.typeLabel)}</td>
              <td title="${esc(fromTip[r.createdFrom] || '')}">${r.createdBy ? esc(r.createdBy) + (r.createdFrom === 'owner' ? ' <span class="nsft-deplrep-tag">' + esc(t('dr_tag_owner', null, 'owner')) + '</span>' : '') : '<span class="nsft-deplrep-muted">—</span>'}<div class="nsft-deplrep-sub">${esc(fmtDate(r.createdDate))}</div></td>
              <td>${r.modifiedBy ? esc(r.modifiedBy) : '<span class="nsft-deplrep-muted">—</span>'}<div class="nsft-deplrep-sub">${esc(fmtDate(r.modifiedDate))}</div></td>
              <td>${r.ownid && r.ownid !== '-5' ? `<a href="/app/common/entity/employee.nl?id=${encodeURIComponent(r.ownid)}" target="_blank" rel="noopener">${esc(r.owner)}</a>` : esc(r.owner)}</td>
              <td>${esc(r.statusLabel)}</td>
              <td><span class="nsft-deplrep-dot ${r.on ? 'is-on' : 'is-off'}"></span>${esc(r.on ? t('dr_yes', null, 'Yes') : t('dr_no', null, 'No'))}</td>
              <td>${esc(r.rec)}</td>
              <td>${r.fid ? `<a href="/app/common/media/mediaitem.nl?id=${encodeURIComponent(r.fid)}" target="_blank" rel="noopener">${esc(r.fname || ('#' + r.fid))}</a>` : ''}</td>
            </tr>`).join('');
        const empty = box.querySelector('.nsft-deplrep-empty');
        empty.hidden = list.length > 0;
        if (!list.length) empty.textContent = t('dr_none', null, 'No deployment matches the filters.');
        setStatus(t('dr_count', [String(list.length), String(rows.length)], list.length + ' of ' + rows.length + ' deployments'));
        box.querySelector('.nsft-deplrep-foot').textContent = list.length > MAX_RENDER
            ? t('dr_more', [String(MAX_RENDER)], 'Showing the first ' + MAX_RENDER + ': narrow the filters or export to CSV to see all.')
            : t('dr_hint2', null, 'Created by = whoever touched the deployment first, from its system notes. Hover the name to see where it came from.');
    }

    function exportCsv() {
        if (!rows) return;
        const list = filtered();
        const head = ['Internal ID', 'Deployment ID', 'Deployment', 'Script ID', 'Script', 'Type', 'Created by', 'Created on', 'Last changed by', 'Last changed on', 'Script owner', 'Status', 'Deployed', 'Applied to', 'File'];
        const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const lines = [head.map(q).join(';')].concat(list.map((r) => [
            r.did, r.dcode, r.dtitle, r.scode, r.sname, r.typeLabel, r.createdBy, r.createdDate, r.modifiedBy, r.modifiedDate,
            r.owner, r.statusLabel, r.on ? t('dr_yes', null, 'Yes') : t('dr_no', null, 'No'), r.rec, r.fname
        ].map(q).join(';')));
        const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'implementacoes_de_script_' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    function icon() {
        return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="20"/><polyline points="13 14 15 16 19 12"/></svg>';
    }
})();
