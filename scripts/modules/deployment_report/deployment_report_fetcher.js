/*
 * NSFT · Relatório de implementações de script — fetcher (mundo MAIN).
 *
 * 1) SuiteQL: TODAS as implementações (scriptdeployment) + o script dono e o
 *    proprietário do script, em blocos de 1000 (paginação por chave).
 * 2) Notas do sistema (via pesquisa: N/search ou, se a página só tiver
 *    SuiteScript 1.0, nlapiCreateSearch): para cada implementação e cada
 *    script, quem mexeu, com a primeira e a última data. Daí sai o
 *    "Criado por" (quem mexeu primeiro) e o "Alterado por" (quem mexeu por último).
 *    O SuiteQL não expõe as notas de scripts/implementações, por isso a pesquisa.
 */
(function () {
    'use strict';
    if (window.__nsftDeplRepFetcherLoaded) return;
    window.__nsftDeplRepFetcherLoaded = true;

    const PAGE = 1000;
    const MAX_ROWS = 20000;
    const DATE_FORMULA = "TO_CHAR({systemnotes.date},'YYYY-MM-DD HH24:MI')";

    function reply(payload) {
        window.postMessage(Object.assign({ dest: 'extension_deplrep' }, payload), '*');
    }

    function errText(e) {
        if (e && typeof e.getDetails === 'function') { try { return String(e.getDetails()); } catch (x) { } }
        return (e && (e.message || e.code)) ? String(e.message || e.code) : String(e);
    }

    /* ---------- 1) SuiteQL ---------- */

    function run(T, sql) {
        return new Promise((resolve, reject) => {
            T.run({ rest: sql, sql: sql, limit: PAGE }, (err, rows) => err ? reject(err) : resolve(rows || []));
        });
    }

    // ATENÇÃO: não colocar d.recordtype aqui. Só alguns tipos (User Event, Client,
    // Mass Update, Workflow Action) têm esse campo, e o NetSuite descarta em
    // silêncio as outras implementações (Suitelet, Scheduled, Map/Reduce…) quando
    // ele é pedido: conta 897 mas devolve 398. O "Aplicado a" vem à parte (fetchRecordTypes).
    const COLS_FULL =
        'd.primarykey AS did, d.scriptid AS dcode, d.title AS dtitle, d.isdeployed AS don, ' +
        'd.status AS dstatus, ' +
        's.id AS sid, s.scriptid AS scode, s.name AS sname, s.scripttype AS stype, ' +
        's.owner AS ownid, BUILTIN.DF(s.owner) AS ownname, s.isinactive AS sinactive, ' +
        's.scriptfile AS fid, BUILTIN.DF(s.scriptfile) AS fname';

    const COLS_MIN =
        'd.primarykey AS did, d.scriptid AS dcode, d.title AS dtitle, d.isdeployed AS don, ' +
        'd.status AS dstatus, s.id AS sid, s.scriptid AS scode, s.name AS sname, ' +
        's.scripttype AS stype, s.owner AS ownid, BUILTIN.DF(s.owner) AS ownname, s.scriptfile AS fid';

    function pageSql(cols, after) {
        return 'SELECT * FROM (SELECT ' + cols +
            ' FROM scriptdeployment d INNER JOIN script s ON s.id = d.script' +
            ' WHERE d.primarykey > ' + Number(after || 0) +
            ' ORDER BY d.primarykey) WHERE ROWNUM <= ' + PAGE;
    }

    async function fetchAll(T, cols, requestId) {
        const all = [];
        let after = 0;
        for (;;) {
            const rows = await run(T, pageSql(cols, after));
            rows.forEach((r) => all.push(r));
            reply({ requestId, type: 'progress', step: 'rows', count: all.length });
            if (rows.length < PAGE || all.length >= MAX_ROWS) break;
            const last = Number(rows[rows.length - 1].did);
            if (!(last > after)) break;
            after = last;
        }
        return all;
    }

    // "Aplicado a" (tipo de registro) só para quem tem — consulta separada, paginada.
    async function fetchRecordTypes(T) {
        const map = {};
        let after = 0;
        for (let guard = 0; guard < 50; guard++) {
            const rows = await run(T,
                'SELECT * FROM (SELECT d.primarykey AS did, BUILTIN.DF(d.recordtype) AS drec' +
                ' FROM scriptdeployment d WHERE d.recordtype IS NOT NULL AND d.primarykey > ' + after +
                ' ORDER BY d.primarykey) WHERE ROWNUM <= ' + PAGE);
            rows.forEach((r) => { map[String(r.did)] = r.drec || ''; });
            if (rows.length < PAGE) break;
            const last = Number(rows[rows.length - 1].did);
            if (!(last > after)) break;
            after = last;
        }
        return map;
    }

    async function countAll(T) {
        try {
            const r = await run(T, 'SELECT COUNT(*) AS n FROM scriptdeployment d INNER JOIN script s ON s.id = d.script');
            return r && r[0] ? Number(r[0].n) : null;
        } catch (e) { return null; }
    }

    /* ---------- 2) Notas do sistema ---------- */

    // Devolve [{ key, uid, uname, first, last }] — uma linha por registro × usuário.
    // keyCol: nome da coluna, ou { formula } para agrupar por fórmula (ex.: '{internalid}').
    function notesSS2(search, type, keyCol) {
        const keyColumn = typeof keyCol === 'string'
            ? search.createColumn({ name: keyCol, summary: search.Summary.GROUP })
            : search.createColumn({ name: 'formulanumeric', summary: search.Summary.GROUP, formula: keyCol.formula });
        const s = search.create({
            type: type,
            filters: [['systemnotes.date', 'isnotempty', '']],
            columns: [
                keyColumn,
                search.createColumn({ name: 'name', join: 'systemNotes', summary: search.Summary.GROUP }),
                search.createColumn({ name: 'formulatext', summary: search.Summary.MIN, formula: DATE_FORMULA }),
                search.createColumn({ name: 'formulatext', summary: search.Summary.MAX, formula: DATE_FORMULA })
            ]
        });
        const cols = s.columns;
        const out = [];
        const paged = s.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach((range) => {
            paged.fetch({ index: range.index }).data.forEach((r) => {
                out.push({
                    key: keyOf(r.getValue(cols[0])),
                    uid: String(r.getValue(cols[1]) || ''),
                    uname: String(r.getText(cols[1]) || r.getValue(cols[1]) || ''),
                    first: String(r.getValue(cols[2]) || ''),
                    last: String(r.getValue(cols[3]) || '')
                });
            });
        });
        return out;
    }

    function notesSS1(type, keyCol) {
        /* global nlapiCreateSearch, nlobjSearchColumn, nlobjSearchFilter */
        const cols = [
            typeof keyCol === 'string'
                ? new nlobjSearchColumn(keyCol, null, 'group')
                : new nlobjSearchColumn('formulanumeric', null, 'group').setFormula(keyCol.formula),
            new nlobjSearchColumn('name', 'systemNotes', 'group'),
            new nlobjSearchColumn('formulatext', null, 'min').setFormula(DATE_FORMULA),
            new nlobjSearchColumn('formulatext', null, 'max').setFormula(DATE_FORMULA)
        ];
        const rs = nlapiCreateSearch(type, [new nlobjSearchFilter('date', 'systemNotes', 'isnotempty')], cols).runSearch();
        const out = [];
        for (let i = 0; i < 50000; i += 1000) {
            const page = rs.getResults(i, i + 1000) || [];
            page.forEach((r) => out.push({
                key: keyOf(r.getValue(cols[0])),
                uid: String(r.getValue(cols[1]) || ''),
                uname: String(r.getText(cols[1]) || r.getValue(cols[1]) || ''),
                first: String(r.getValue(cols[2]) || ''),
                last: String(r.getValue(cols[3]) || '')
            }));
            if (page.length < 1000) break;
        }
        return out;
    }

    function keyOf(v) {
        const s = String(v == null ? '' : v).trim();
        const n = Number(s);
        return Number.isFinite(n) && s !== '' ? String(Math.round(n)) : s;
    }

    function loadNSearch() {
        return new Promise((resolve) => {
            if (typeof window.require !== 'function') { resolve(null); return; }
            try { window.require(['N/search'], (s) => resolve(s), () => resolve(null)); }
            catch (e) { resolve(null); }
        });
    }

    async function fetchNotes() {
        const search = await loadNSearch();
        const hasSS1 = typeof window.nlapiCreateSearch === 'function';
        if (!search && !hasSS1) return { error: 'no-search-api' };
        const get = (type, keyCol) => search ? notesSS2(search, type, keyCol) : notesSS1(type, keyCol);
        const out = { deployments: [], scripts: [] };
        // Por ID interno: o scriptid da implementação (customdeploy1, customdeploy2…)
        // só é único dentro de cada script e se repete entre scripts diferentes.
        try { out.deployments = get('scriptdeployment', { formula: '{internalid}' }); }
        catch (e) { out.error = errText(e); }
        try { out.scripts = get('script', 'internalid'); }
        catch (e) { if (!out.error) out.error = errText(e); }
        return out;
    }

    /* ---------- mensagens ---------- */

    window.addEventListener('message', async function (event) {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.dest !== 'fetcher_deplrep' || d.type !== 'load') return;
        const T = window.NSFT_SQL;
        if (!T) { reply({ requestId: d.requestId, type: 'done', error: 'SuiteQL transport unavailable' }); return; }
        let rows;
        try {
            try { rows = await fetchAll(T, COLS_FULL, d.requestId); }
            catch (e) { rows = await fetchAll(T, COLS_MIN, d.requestId); }
        } catch (e) {
            reply({ requestId: d.requestId, type: 'done', error: errText(e) });
            return;
        }
        let expected = null;
        try {
            const rt = await fetchRecordTypes(T);
            rows.forEach((r) => { if (rt[String(r.did)] != null) r.drec = rt[String(r.did)]; });
        } catch (e) { /* "Aplicado a" é opcional */ }
        expected = await countAll(T);
        reply({ requestId: d.requestId, type: 'progress', step: 'notes', count: rows.length });
        let notes;
        try { notes = await fetchNotes(); }
        catch (e) { notes = { error: errText(e), deployments: [], scripts: [] }; }
        reply({ requestId: d.requestId, type: 'done', rows, notes, expected });
    });
})();
