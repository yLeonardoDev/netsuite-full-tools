/*
 * NSFT · Scripts implementados no File Cabinet.
 *
 * Nas pastas do File Cabinet (ex.: SuiteScripts › Engenharia - Desenvolvimento)
 * descobre quais arquivos são o "Script File" de um registro de Script e:
 *  - adiciona o botão "Ver script" na barra de ações da linha (ao lado de
 *    Editar arquivo / Renomear / Excluir), que abre /app/common/scripting/script.nl?id=…;
 *  - adiciona uma etiqueta com o estado das implementações (clique = lista de
 *    implementações com link direto para cada uma);
 *  - mostra uma barra com a contagem e o filtro "Ver só scripts implementados".
 */
(function () {
    'use strict';
    const STORAGE_KEY = 'enableFileCabinetDeployedScripts';
    const FILTER_KEY = 'nsft_fcds_only_deployed';
    const PILL_CLASS = 'nsft-fcds-pill';
    const VIEW_CLASS = 'nsft-fcds-view';
    const BAR_ID = 'nsft-fcds-bar';
    const POP_ID = 'nsft-fcds-pop';
    const HIDDEN_CLASS = 'nsft-fcds-hidden';
    const FILE_NAME_RE = /\.[a-z0-9]{1,6}$/i;
    const SCRIPT_EXT_RE = /\.(js|mjs|cjs|ts)$/i;
    const ACTION_TEXT_RE = /^(Editar|Edit|Descargar|Download|Baixar|Visualizar|Ver|View|Renomear|Rename|Renombrar|Excluir|Delete|Eliminar)$/i;

    const t = (k, subs, fb) => {
        try { const m = chrome.i18n.getMessage(k, subs); if (m) return m; } catch (e) { }
        return fb || k;
    };

    const TYPE_LABELS = {
        USEREVENT: 'User Event', CLIENT: 'Client', SCRIPTLET: 'Suitelet', RESTLET: 'RESTlet',
        MAPREDUCE: 'Map/Reduce', SCHEDULED: 'Scheduled', ACTION: 'Workflow Action',
        MASSUPDATE: 'Mass Update', PORTLET: 'Portlet', BUNDLEINSTALLATION: 'Bundle Installation',
        SDFINSTALLATION: 'SDF Installation', EMAILCAPTURE: 'Email Capture', PLUGINTYPE: 'Plug-in',
        CUSTOMGLLINES: 'Custom GL Lines', CONSOLRATEADJUSTOR: 'Consolidated Rate Adjustor'
    };

    let enabled = false;
    let _unsub = null;
    let _fetcherReady = null;
    let _reqSeq = 0;
    const _pending = new Map();      // requestId -> resolve
    const info = new Map();          // fileId -> { scripts: [...] } | null (sem script)
    const asked = new Set();         // fileIds já consultados / em consulta
    let queueTimer = null;
    let queued = [];
    let loading = 0;
    let lastError = '';

    function isApplicablePage() {
        try {
            if (window.NSFT_RecordButtons && NSFT_RecordButtons.isExcludedPage && NSFT_RecordButtons.isExcludedPage()) return false;
        } catch (e) { }
        return /mediaitemfolders?\.nl/i.test(location.pathname);
    }

    chrome.storage.local.get({ [STORAGE_KEY]: true }, (items) => {
        enabled = !!items[STORAGE_KEY];
        if (enabled && isApplicablePage()) init();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_KEY]) return;
        enabled = !!changes[STORAGE_KEY].newValue;
        if (enabled) { if (isApplicablePage()) init(); }
        else teardown();
    });

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.dest !== 'extension_fcds') return;
        const res = _pending.get(d.requestId);
        if (!res) return;
        _pending.delete(d.requestId);
        res(d);
    });

    function teardown() {
        if (_unsub) { _unsub(); _unsub = null; }
        document.querySelectorAll('.' + PILL_CLASS + ', .' + VIEW_CLASS).forEach((b) => b.remove());
        document.querySelectorAll('.' + HIDDEN_CLASS).forEach((r) => r.classList.remove(HIDDEN_CLASS));
        const bar = document.getElementById(BAR_ID); if (bar) bar.remove();
        closePop();
    }

    function init() {
        if (_unsub) return;
        runOnce();
        if (window.NSFT_Observer && typeof window.NSFT_Observer.subscribe === 'function') {
            _unsub = window.NSFT_Observer.subscribe(runOnce, { throttle: 400 });
        } else {
            const mo = new MutationObserver(runOnce);
            mo.observe(document.body, { childList: true, subtree: true });
            _unsub = () => mo.disconnect();
        }
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
    }

    /* ---------- leitura das linhas ---------- */

    function rowFile(row) {
        if (row.querySelector('img[src*="folder.gif"]')) return null;

        // ID do arquivo: qualquer link mediaitem.nl?id=… (Editar ou o próprio nome)
        let fileId = null;
        for (const a of row.querySelectorAll('a[href]')) {
            const href = a.getAttribute('href') || '';
            if (/mediaitemfolders?\.nl/i.test(href)) continue;
            if (!/mediaitem\.nl|media\.nl/i.test(href)) continue;
            let id = null;
            try { id = new URL(href, location.origin).searchParams.get('id'); } catch (e) { }
            if (id && /^\d+$/.test(id)) { fileId = id; if (/mediaitem\.nl/i.test(href)) break; }
        }
        if (!fileId) return null;

        // Nome: o link cujo texto parece um nome de arquivo (tem extensão).
        let name = '', nameAnchor = null, fallback = null;
        for (const a of row.querySelectorAll('a')) {
            if (a.closest('.nsft-fc-actions-bar')) continue;
            const txt = (a.textContent || '').trim();
            if (!txt || ACTION_TEXT_RE.test(txt)) continue;
            if (/downloadfolder\.nl/.test(a.getAttribute('href') || '')) continue;
            if (FILE_NAME_RE.test(txt)) { name = txt; nameAnchor = a; break; }
            if (!fallback) fallback = a;
        }
        if (!nameAnchor && fallback) { nameAnchor = fallback; name = (fallback.textContent || '').trim(); }
        // Se não achamos extensão em lugar nenhum, procura no texto das células.
        if (!FILE_NAME_RE.test(name)) {
            for (const td of row.querySelectorAll('td')) {
                const txt = (td.textContent || '').trim();
                if (FILE_NAME_RE.test(txt) && txt.length < 200) { name = txt; break; }
            }
        }
        return { fileId, name, nameAnchor };
    }

    function listRows() {
        return Array.from(document.querySelectorAll('tr.uir-list-row-tr'));
    }

    function runOnce() {
        if (!enabled) return;
        const rows = listRows();
        if (!rows.length) return;
        const toAsk = [];
        rows.forEach((row) => {
            const f = row.__nsftFcds || (row.__nsftFcds = rowFile(row) || { skip: true });
            if (f.skip) return;
            // Só descarta quando temos certeza de que NÃO é script (extensão conhecida e diferente).
            if (FILE_NAME_RE.test(f.name) && !SCRIPT_EXT_RE.test(f.name)) { f.skip = true; return; }
            if (!asked.has(f.fileId)) { asked.add(f.fileId); toAsk.push(f.fileId); }
            else if (info.has(f.fileId)) paintRow(row, f);
        });
        if (toAsk.length) enqueue(toAsk);
        ensureBar();
        updateBar();
        applyFilter();
    }

    /* ---------- consulta ---------- */

    function enqueue(ids) {
        queued = queued.concat(ids);
        clearTimeout(queueTimer);
        queueTimer = setTimeout(flush, 120);
    }

    async function flush() {
        const ids = queued; queued = [];
        if (!ids.length) return;
        loading++; updateBar(); applyFilter();
        try {
            const d = await query(ids);
            if (d.error) {
                lastError = String(d.error);
                ids.forEach((id) => asked.delete(id));
                try { console.warn('[NSFT] Scripts implementados: falha na consulta —', d.error); } catch (e) { }
            } else {
                lastError = '';
                ids.forEach((id) => info.set(id, null));
                (d.rows || []).forEach(addRow);
            }
        } catch (e) {
            lastError = String((e && e.message) || e);
            ids.forEach((id) => asked.delete(id));
        }
        loading--;
        listRows().forEach((row) => { const f = row.__nsftFcds; if (f && !f.skip && info.has(f.fileId)) paintRow(row, f); });
        updateBar();
        applyFilter();
    }

    function isTrue(v) {
        return v === true || /^(t|true|y|yes|s|sim|1)$/i.test(String(v == null ? '' : v).trim());
    }

    function addRow(r) {
        const fid = String(r.fid);
        let entry = info.get(fid);
        if (!entry) { entry = { scripts: [] }; info.set(fid, entry); }
        let s = entry.scripts.find((x) => x.id === String(r.sid));
        if (!s) {
            s = { id: String(r.sid), code: r.scode || '', name: r.sname || r.scode || ('#' + r.sid), type: String(r.stype || ''), deps: [] };
            entry.scripts.push(s);
        }
        if (r.did != null && r.did !== '' && !s.deps.some((x) => x.id === String(r.did))) {
            s.deps.push({
                id: String(r.did), code: r.dcode || '', title: r.dtitle || r.dcode || ('#' + r.did),
                on: isTrue(r.don),
                status: String(r.dstatus || '')
            });
        }
    }

    function ensureFetcher() {
        if (_fetcherReady) return _fetcherReady;
        _fetcherReady = new Promise((resolve) => {
            try { window.NSFT_SuiteQLRest && window.NSFT_SuiteQLRest.ensureTransport(); } catch (e) { }
            const s = document.createElement('script');
            s.async = false;
            s.src = chrome.runtime.getURL('scripts/modules/file_cabinet_deployed_scripts/file_cabinet_deployed_scripts_fetcher.js');
            s.onload = function () { this.remove(); resolve(); };
            s.onerror = function () { this.remove(); resolve(); };
            (window.NSFT_AfterLoad ? window.NSFT_AfterLoad.append(s) : (document.head || document.documentElement).appendChild(s));
        });
        return _fetcherReady;
    }

    async function query(ids) {
        await ensureFetcher();
        const requestId = 'fcds_' + (++_reqSeq) + '_' + Date.now();
        return new Promise((resolve) => {
            const timer = setTimeout(() => { _pending.delete(requestId); resolve({ error: 'timeout' }); }, 45000);
            _pending.set(requestId, (d) => { clearTimeout(timer); resolve(d); });
            window.postMessage({ dest: 'fetcher_fcds', type: 'query', ids, requestId }, '*');
        });
    }

    /* ---------- botões da linha ---------- */

    function summary(entry) {
        let total = 0, on = 0;
        entry.scripts.forEach((s) => { total += s.deps.length; s.deps.forEach((d) => { if (d.on) on++; }); });
        return { total, on };
    }

    function scriptUrl(id) {
        return '/app/common/scripting/script.nl?id=' + encodeURIComponent(id);
    }

    function paintRow(row, f) {
        const entry = info.get(f.fileId);
        if (!entry) {
            row.querySelectorAll('.' + PILL_CLASS + ', .' + VIEW_CLASS).forEach((b) => b.remove());
            if (row.dataset.nsftFcds !== 'none') row.dataset.nsftFcds = 'none';
            return;
        }
        if (row.querySelector('.' + VIEW_CLASS)) return;
        const { total, on } = summary(entry);
        const state = on > 0 ? 'on' : (total > 0 ? 'off' : 'nodep');
        row.dataset.nsftFcds = state;

        const bar = getOrCreateActionsBar(row, f.nameAnchor);
        if (!bar) return;

        // 1) "Ver script": vai direto ao registro do script (ou lista, se houver vários).
        const view = document.createElement('a');
        view.className = VIEW_CLASS + ' nsft-pastilla is-fila';
        view.innerHTML = svgCode() + '<span></span>';
        view.querySelector('span').textContent = t('fcds_view_script', null, 'View script');
        if (entry.scripts.length === 1) {
            const s = entry.scripts[0];
            view.href = scriptUrl(s.id);
            view.target = '_blank';
            view.rel = 'noopener';
            view.title = t('fcds_view_script_tip', [s.name], 'Open the script record: ' + s.name);
        } else {
            view.href = '#';
            view.title = t('fcds_choose_script', [String(entry.scripts.length)], entry.scripts.length + ' scripts use this file: pick one');
            view.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPop(view, f, entry); });
        }
        bar.appendChild(view);

        // 2) Estado das implementações (clique = lista com links).
        const pill = document.createElement('a');
        pill.href = '#';
        pill.className = PILL_CLASS + ' nsft-pastilla is-fila is-' + state;
        pill.title = t('fcds_pill_tooltip', null, 'Click to see the script and its deployments');
        let label;
        if (state === 'on') label = t('fcds_pill_deployed', [String(on)], 'Deployed · ' + on);
        else if (state === 'off') label = t('fcds_pill_disabled', [String(total)], 'Deployments off · ' + total);
        else label = t('fcds_pill_no_deploy', null, 'Script · no deployment');
        pill.innerHTML = svgRocket() + '<span></span>';
        pill.querySelector('span').textContent = label;
        pill.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openPop(pill, f, entry); });
        bar.appendChild(pill);
    }

    function getOrCreateActionsBar(row, nameAnchor) {
        let bar = row.querySelector('.nsft-fc-actions-bar');
        if (bar) return bar;
        bar = document.createElement('div');
        bar.className = 'nsft-fc-actions-bar';
        if (nameAnchor && nameAnchor.parentNode) nameAnchor.insertAdjacentElement('afterend', bar);
        else {
            const firstCell = row.querySelector('td');
            if (!firstCell) return null;
            firstCell.appendChild(bar);
        }
        return bar;
    }

    /* ---------- popover ---------- */

    function closePop() {
        const p = document.getElementById(POP_ID);
        if (p) p.remove();
    }

    function onDocClick(e) {
        const p = document.getElementById(POP_ID);
        if (p && !p.contains(e.target) && !e.target.closest('.' + PILL_CLASS + ', .' + VIEW_CLASS)) closePop();
    }

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function link(href, text, cls) {
        const a = el('a', cls, text);
        a.href = href; a.target = '_blank'; a.rel = 'noopener';
        return a;
    }

    function openPop(anchor, f, entry) {
        closePop();
        const pop = el('div', 'nsft-fcds-pop');
        pop.id = POP_ID;
        pop.setAttribute('role', 'dialog');

        const head = el('div', 'nsft-fcds-pop-head');
        head.appendChild(el('strong', null, t('fcds_pop_title', null, 'Scripts that use this file')));
        head.appendChild(el('span', 'nsft-fcds-pop-file', f.name || ('#' + f.fileId)));
        const x = el('button', 'nsft-fcds-pop-x', '×');
        x.type = 'button'; x.title = t('fcds_close', null, 'Close');
        x.addEventListener('click', closePop);
        head.appendChild(x);
        pop.appendChild(head);

        entry.scripts.forEach((s) => {
            const box = el('div', 'nsft-fcds-script');
            const top = el('div', 'nsft-fcds-script-top');
            top.appendChild(link(scriptUrl(s.id), s.name, 'nsft-fcds-script-name'));
            if (s.type) top.appendChild(el('span', 'nsft-fcds-tag', TYPE_LABELS[s.type.toUpperCase()] || s.type));
            box.appendChild(top);
            if (s.code) box.appendChild(el('div', 'nsft-fcds-code', s.code));

            if (!s.deps.length) {
                box.appendChild(el('div', 'nsft-fcds-empty', t('fcds_no_deployments', null, 'This script has no deployments.')));
            } else {
                const ul = el('ul', 'nsft-fcds-deps');
                s.deps.forEach((d) => {
                    const li = el('li', 'nsft-fcds-dep ' + (d.on ? 'is-on' : 'is-off'));
                    const dot = el('span', 'nsft-fcds-dot');
                    dot.title = d.on ? t('fcds_dep_on', null, 'Deployed') : t('fcds_dep_off', null, 'Not deployed');
                    li.appendChild(dot);
                    li.appendChild(link('/app/common/scripting/scriptrecord.nl?id=' + encodeURIComponent(d.id), d.title, 'nsft-fcds-dep-link'));
                    const meta = [d.code, d.status ? prettyStatus(d.status) : '', d.on ? '' : t('fcds_dep_off', null, 'Not deployed')]
                        .filter(Boolean).join(' · ');
                    if (meta) li.appendChild(el('span', 'nsft-fcds-meta', meta));
                    ul.appendChild(li);
                });
                box.appendChild(ul);
            }
            const actions = el('div', 'nsft-fcds-actions');
            actions.appendChild(link(scriptUrl(s.id), t('fcds_view_script', null, 'View script'), 'nsft-fcds-btn'));
            box.appendChild(actions);
            pop.appendChild(box);
        });

        document.body.appendChild(pop);
        const r = anchor.getBoundingClientRect();
        const w = pop.offsetWidth, h = pop.offsetHeight;
        let left = r.left + window.scrollX;
        let top = r.bottom + window.scrollY + 6;
        if (left + w > window.scrollX + document.documentElement.clientWidth - 8) left = window.scrollX + document.documentElement.clientWidth - w - 8;
        if (r.bottom + h + 8 > window.innerHeight && r.top - h - 6 > 0) top = r.top + window.scrollY - h - 6;
        pop.style.left = Math.max(8, left) + 'px';
        pop.style.top = top + 'px';
    }

    function prettyStatus(s) {
        const k = String(s).toUpperCase();
        const map = { RELEASED: 'fcds_status_released', TESTING: 'fcds_status_testing', NOTSCHEDULED: 'fcds_status_notscheduled', SCHEDULED: 'fcds_status_scheduled' };
        return map[k] ? t(map[k], null, s) : s;
    }

    /* ---------- barra de filtro ---------- */

    function onlyDeployed() {
        try { return sessionStorage.getItem(FILTER_KEY) === '1'; } catch (e) { return false; }
    }

    function ensureBar() {
        if (document.getElementById(BAR_ID)) return;
        const first = document.querySelector('tr.uir-list-row-tr');
        const table = first && first.closest('table');
        if (!table || !table.parentNode) return;
        const bar = el('div', 'nsft-fcds-bar');
        bar.id = BAR_ID;
        bar.innerHTML = svgRocket();
        bar.appendChild(el('span', 'nsft-fcds-bar-text'));
        const lbl = el('label', 'nsft-fcds-bar-toggle');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = onlyDeployed();
        cb.addEventListener('change', () => {
            try { sessionStorage.setItem(FILTER_KEY, cb.checked ? '1' : '0'); } catch (e) { }
            applyFilter();
        });
        lbl.appendChild(cb);
        lbl.appendChild(el('span', null, t('fcds_filter_only', null, 'Show only deployed scripts')));
        bar.appendChild(lbl);
        table.parentNode.insertBefore(bar, table);
    }

    function counts() {
        let files = 0, withScript = 0, deployed = 0;
        listRows().forEach((row) => {
            const f = row.__nsftFcds; if (!f || f.skip) return;
            files++;
            const st = row.dataset.nsftFcds;
            if (st && st !== 'none') withScript++;
            if (st === 'on' || st === 'off') deployed++;
        });
        return { files, withScript, deployed };
    }

    function updateBar() {
        const bar = document.getElementById(BAR_ID);
        if (!bar) return;
        const txt = bar.querySelector('.nsft-fcds-bar-text');
        const set = (v) => { if (txt.textContent !== v) txt.textContent = v; };
        bar.classList.toggle('is-error', !!lastError);
        if (lastError) { set(t('fcds_error', [lastError], 'Could not check deployments: ' + lastError)); return; }
        if (loading > 0) { set(t('fcds_loading', null, 'Checking deployments…')); return; }
        const c = counts();
        set(t('fcds_bar_count', [String(c.deployed), String(c.withScript), String(c.files)],
            c.deployed + ' deployed · ' + c.withScript + ' with a Script record · ' + c.files + ' script files on this page'));
    }

    function applyFilter() {
        // Enquanto carrega ou se a consulta falhou, nunca esconde nada.
        const only = onlyDeployed() && !lastError && loading === 0;
        listRows().forEach((row) => {
            const f = row.__nsftFcds;
            const st = row.dataset.nsftFcds;
            const keep = !only
                || !!row.querySelector('img[src*="folder.gif"]')
                || (f && !f.skip && (st === 'on' || st === 'off'));
            if (row.classList.contains(HIDDEN_CLASS) === !!keep) row.classList.toggle(HIDDEN_CLASS, !keep);
        });
    }

    function svgRocket() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>';
    }

    function svgCode() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
    }
})();
