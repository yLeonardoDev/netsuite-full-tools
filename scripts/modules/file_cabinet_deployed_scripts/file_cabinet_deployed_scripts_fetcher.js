/*
 * NSFT · Scripts implementados no File Cabinet — fetcher (mundo MAIN).
 * Recebe uma lista de IDs de arquivo e devolve os registros de Script que
 * usam cada arquivo como "Script File", com as suas implementações.
 * Primeiro tenta uma consulta só (script + scriptdeployment); se a conta
 * recusar o JOIN, faz duas consultas separadas e junta o resultado aqui.
 */
(function () {
    'use strict';

    if (window.__nsftFcdsFetcherLoaded) return;
    window.__nsftFcdsFetcherLoaded = true;

    const CHUNK = 150;

    function reply(requestId, error, rows) {
        window.postMessage({ dest: 'extension_fcds', requestId: requestId, error: error || null, rows: rows || null }, '*');
    }

    function run(T, sql) {
        return new Promise((resolve, reject) => {
            T.run({ rest: sql, sql: sql, limit: 1000 }, (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });
    }

    function errText(e) {
        return (e && (e.message || e.code)) ? String(e.message || e.code) : String(e);
    }

    async function joined(T, ids) {
        return run(T,
            'SELECT s.id AS sid, s.scriptid AS scode, s.name AS sname, s.scripttype AS stype, ' +
            's.scriptfile AS fid, d.primarykey AS did, d.scriptid AS dcode, d.title AS dtitle, ' +
            'd.isdeployed AS don, d.status AS dstatus ' +
            'FROM script s LEFT OUTER JOIN scriptdeployment d ON d.script = s.id ' +
            'WHERE s.scriptfile IN (' + ids.join(',') + ') ' +
            'ORDER BY s.name, d.title');
    }

    async function separate(T, ids) {
        const scripts = await run(T,
            'SELECT s.id AS sid, s.scriptid AS scode, s.name AS sname, s.scripttype AS stype, s.scriptfile AS fid ' +
            'FROM script s WHERE s.scriptfile IN (' + ids.join(',') + ')');
        if (!scripts.length) return [];
        const sids = scripts.map((r) => String(r.sid)).filter((x) => /^\d+$/.test(x));
        let deps = [];
        try {
            deps = await run(T,
                'SELECT d.script AS sid, d.primarykey AS did, d.scriptid AS dcode, d.title AS dtitle, ' +
                'd.isdeployed AS don, d.status AS dstatus FROM scriptdeployment d ' +
                'WHERE d.script IN (' + sids.join(',') + ')');
        } catch (e) { deps = []; }
        const out = [];
        scripts.forEach((s) => {
            const mine = deps.filter((d) => String(d.sid) === String(s.sid));
            if (!mine.length) out.push(Object.assign({}, s));
            mine.forEach((d) => out.push(Object.assign({}, s, d, { sid: s.sid })));
        });
        return out;
    }

    window.addEventListener('message', async function (event) {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.dest !== 'fetcher_fcds' || d.type !== 'query') return;

        const T = window.NSFT_SQL;
        const ids = (Array.isArray(d.ids) ? d.ids : []).map(String).filter((x) => /^\d+$/.test(x));
        if (!T) { reply(d.requestId, 'SuiteQL transport unavailable'); return; }
        if (!ids.length) { reply(d.requestId, null, []); return; }

        const all = [];
        try {
            for (let i = 0; i < ids.length; i += CHUNK) {
                const part = ids.slice(i, i + CHUNK);
                let rows;
                try { rows = await joined(T, part); }
                catch (e) { rows = await separate(T, part); }
                rows.forEach((r) => all.push(r));
            }
            reply(d.requestId, null, all);
        } catch (e) {
            reply(d.requestId, errText(e));
        }
    });
})();
