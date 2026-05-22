const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const mysql    = require('mysql2');
const cors     = require('cors');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const CARPETA_FOTOS = path.join(__dirname, '..', 'capturas_institucionales');
app.use('/fotos', express.static(CARPETA_FOTOS));

// ── POOL (mejor que conexión única) ─────────────────────────────────────────
// Railway provee MYSQL_URL como connection string — úsalo si existe
function buildPoolConfig() {
    const urlStr = process.env.MYSQL_URL || process.env.DATABASE_URL;
    if (urlStr && urlStr.startsWith('mysql')) {
        const u = new URL(urlStr);
        console.log(`DB → ${u.hostname}:${u.port}${u.pathname}`);
        return {
            host:     u.hostname,
            port:     parseInt(u.port) || 3306,
            user:     u.username,
            password: u.password,
            database: u.pathname.slice(1),
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        };
    }
    console.log(`DB → ${process.env.MYSQLHOST || 'localhost'}:${process.env.MYSQLPORT || 3306}`);
    return {
        host:     process.env.MYSQLHOST     || process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
        user:     process.env.MYSQLUSER     || process.env.DB_USER     || 'root',
        password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || 'root',
        database: process.env.MYSQLDATABASE || process.env.DB_NAME     || 'sistema_conteo',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    };
}

const pool = mysql.createPool(buildPoolConfig());

const q = (sql, params) => new Promise((resolve, reject) =>
    pool.query(sql, params || [], (err, rows) => err ? reject(err) : resolve(rows))
);

// ── INIT DB ──────────────────────────────────────────────────────────────────
async function initDB() {
    await q(`CREATE TABLE IF NOT EXISTS conteo_peatonal (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        modulo       VARCHAR(100) DEFAULT NULL,
        tipo_entrada VARCHAR(30)  DEFAULT NULL,
        foto         VARCHAR(255) DEFAULT NULL,
        categoria    VARCHAR(30)  DEFAULT NULL,
        tracking_id  INT          DEFAULT NULL,
        fecha_hora   DATETIME     DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS rostros_conocidos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        nombre      VARCHAR(100) NOT NULL,
        tracking_id INT          UNIQUE,
        tipo_carro  VARCHAR(50)  DEFAULT NULL,
        placa       VARCHAR(20)  DEFAULT NULL,
        registrado  DATETIME     DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS placas_conocidas (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        numero_placa VARCHAR(20)  NOT NULL UNIQUE,
        propietario  VARCHAR(100) DEFAULT NULL,
        tipo_carro   VARCHAR(50)  DEFAULT NULL,
        registrado   DATETIME     DEFAULT NOW()
    )`);
    // Migración compatible MySQL 5.7+: agrega columnas solo si no existen
    async function addColIfMissing(table, col, def) {
        const rows = await q(
            `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
            [table, col]
        );
        if (!rows.length) await q(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
    await addColIfMissing('conteo_peatonal',  'rostro_id',    'INT          DEFAULT NULL');
    await addColIfMissing('conteo_peatonal',  'categoria',    'VARCHAR(30)  DEFAULT NULL');
    await addColIfMissing('conteo_peatonal',  'tracking_id',  'INT          DEFAULT NULL');
    await addColIfMissing('conteo_peatonal',  'foto',         'VARCHAR(255) DEFAULT NULL');
    await addColIfMissing('conteo_peatonal',  'numero_placa', 'VARCHAR(20)  DEFAULT NULL');
    await addColIfMissing('placas_conocidas', 'tipo_carro',   'VARCHAR(50)  DEFAULT NULL');
    await addColIfMissing('rostros_conocidos','tipo_persona',  'VARCHAR(20)  DEFAULT NULL');
    await addColIfMissing('rostros_conocidos','num_control',   'VARCHAR(30)  DEFAULT NULL');
    await addColIfMissing('rostros_conocidos','cargo',         'VARCHAR(80)  DEFAULT NULL');

    // ── PASO 0: Nulificar rostro_id huérfanos (apuntan a IDs ya borrados) ──
    await q(`
        UPDATE conteo_peatonal cp
        LEFT JOIN rostros_conocidos rk ON cp.rostro_id = rk.id
        SET cp.rostro_id = NULL
        WHERE cp.rostro_id IS NOT NULL AND rk.id IS NULL
    `).catch(e => console.error('Nullify orphan rostro_id:', e.message));

    // ── DEDUP rostros_conocidos: remap antes de borrar ──
    const dupMaps = await q(`
        SELECT rk.id AS old_id, MAX(rk2.id) AS keep_id
        FROM rostros_conocidos rk
        JOIN rostros_conocidos rk2
            ON rk.nombre = rk2.nombre
            AND (rk.tracking_id = rk2.tracking_id OR (rk.tracking_id IS NULL AND rk2.tracking_id IS NULL))
        WHERE rk.id < rk2.id
        GROUP BY rk.id
    `).catch(() => []);
    for (const { old_id, keep_id } of dupMaps) {
        await q('UPDATE conteo_peatonal SET rostro_id=? WHERE rostro_id=?', [keep_id, old_id]).catch(() => {});
    }
    await q(`
        DELETE rk FROM rostros_conocidos rk
        INNER JOIN rostros_conocidos rk2
            ON rk.nombre = rk2.nombre
            AND (rk.tracking_id = rk2.tracking_id OR (rk.tracking_id IS NULL AND rk2.tracking_id IS NULL))
        WHERE rk.id < rk2.id
    `).catch(() => {});

    // ── Reparar RC con rostro_id NULL ──
    // Caso 1: tracking_id conocido → join directo
    await q(`
        UPDATE conteo_peatonal cp
        JOIN rostros_conocidos rk ON rk.tracking_id = cp.tracking_id
        SET cp.rostro_id = rk.id
        WHERE cp.categoria = 'Rostro_Conocido' AND cp.rostro_id IS NULL AND cp.tracking_id IS NOT NULL
    `).catch(e => console.error('Repair (tracking_id):', e.message));
    // Caso 2: tracking_id NULL → usar MAX(id) de personas con tracking NULL
    const nullFallback = await q(`SELECT MAX(id) AS keep_id FROM rostros_conocidos WHERE tracking_id IS NULL`).catch(() => []);
    if (nullFallback[0]?.keep_id) {
        await q(`
            UPDATE conteo_peatonal
            SET rostro_id = ?
            WHERE categoria = 'Rostro_Conocido' AND rostro_id IS NULL AND tracking_id IS NULL
        `, [nullFallback[0].keep_id]).catch(e => console.error('Repair (null-tid):', e.message));
    }
    console.log(`Repair done. Fallback rostro_id=${nullFallback[0]?.keep_id || 'none'}`);

    console.log('DB lista.');
}

// ── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
    console.log(`Cliente WS conectado: ${socket.id}`);
    socket.on('disconnect', () => console.log(`Cliente WS desconectado: ${socket.id}`));
});

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    pool.query('SELECT 1', err =>
        err
            ? res.status(503).json({ status: 'error', db: false, uptime: process.uptime() })
            : res.json({ status: 'ok', db: true, uptime: Math.floor(process.uptime()) })
    );
});

// ── STATS ────────────────────────────────────────────────────────────────────
// RC / PC: personas únicas en tablas maestras (no capturas)
// RD / PD: total de capturas sin identificar
app.get('/stats', async (req, res) => {
    try {
        const [[rc], [rd], [pc], [pd]] = await Promise.all([
            q('SELECT COUNT(DISTINCT nombre) AS n FROM rostros_conocidos'),
            q(`SELECT COUNT(DISTINCT COALESCE(tracking_id, id)) AS n
               FROM conteo_peatonal
               WHERE tipo_entrada = 'Rostro'
                 AND (categoria = 'Rostro_Desconocido' OR categoria IS NULL OR categoria = '')`),
            q('SELECT COUNT(DISTINCT numero_placa) AS n FROM placas_conocidas'),
            q(`SELECT COUNT(DISTINCT COALESCE(tracking_id, id)) AS n
               FROM conteo_peatonal
               WHERE tipo_entrada = 'Placa'
                 AND (categoria = 'Placa_Desconocida' OR categoria IS NULL OR categoria = '')`),
        ]);
        res.json({
            Rostro_Conocido:    Number(rc.n),
            Rostro_Desconocido: Number(rd.n),
            Placa_Conocida:     Number(pc.n),
            Placa_Desconocida:  Number(pd.n),
        });
    } catch { res.status(500).json({ error: 'Error stats' }); }
});

// ── POST /conteo ─────────────────────────────────────────────────────────────
app.post('/conteo', async (req, res) => {
    const { modulo, tipo_entrada, foto, tracking_id } = req.body;

    try {
        let categoria;

        if (tipo_entrada === 'Rostro') {
            if (tracking_id != null) {
                const rows = await q('SELECT id FROM rostros_conocidos WHERE tracking_id = ?', [tracking_id]);
                categoria = rows.length ? 'Rostro_Conocido' : 'Rostro_Desconocido';
            } else {
                categoria = 'Rostro_Desconocido';
            }
        } else if (tipo_entrada === 'Placa') {
            if (tracking_id != null) {
                const rows = await q('SELECT id FROM placas_conocidas WHERE numero_placa = ?', [String(tracking_id)]);
                categoria = rows.length ? 'Placa_Conocida' : 'Placa_Desconocida';
            } else {
                categoria = 'Placa_Desconocida';
            }
        } else {
            categoria = 'Desconocido';
        }

        const result = await q(
            'INSERT INTO conteo_peatonal (modulo, tipo_entrada, foto, categoria, tracking_id) VALUES (?, ?, ?, ?, ?)',
            [modulo, tipo_entrada, foto || null, categoria, tracking_id ?? null]
        );

        const record = {
            id: result.insertId, modulo, tipo_entrada,
            foto: foto || null, categoria,
            tracking_id: tracking_id ?? null,
            fecha_registro: new Date().toISOString()
        };

        io.emit('nueva_deteccion', record);

        console.log(`[${categoria}] ${tipo_entrada} | foto: ${foto}`);
        res.json({ mensaje: 'Registro guardado', id: result.insertId, categoria });

    } catch(err) {
        console.error('Error /conteo:', err);
        res.status(500).json({ error: 'Fallo al guardar' });
    }
});

// ── SELECT de persona — dos JOINs independientes + COALESCE para máxima robustez
// rk_id: join por rostro_id (FK directa, más confiable)
// rk_tid: join por tracking_id (fallback cuando rostro_id es NULL)
const PERSONA_SELECT = `
    SELECT cp.id, cp.modulo, cp.tipo_entrada, cp.foto, cp.categoria,
           cp.tracking_id, cp.fecha_hora AS fecha_registro,
           COALESCE(rk_id.nombre,      rk_tid.nombre)      AS nombre,
           COALESCE(rk_id.tipo_carro,  rk_tid.tipo_carro)  AS tipo_carro,
           COALESCE(rk_id.placa,       rk_tid.placa)       AS placa_carro,
           COALESCE(rk_id.tipo_persona,rk_tid.tipo_persona) AS tipo_persona,
           COALESCE(rk_id.num_control, rk_tid.num_control)  AS num_control,
           COALESCE(rk_id.cargo,       rk_tid.cargo)        AS cargo,
           pk.numero_placa, pk.propietario, pk.tipo_carro AS tipo_carro_placa
    FROM conteo_peatonal cp
    LEFT JOIN rostros_conocidos rk_id
        ON cp.tipo_entrada = 'Rostro'
        AND cp.rostro_id IS NOT NULL
        AND cp.rostro_id = rk_id.id
    LEFT JOIN rostros_conocidos rk_tid
        ON cp.tipo_entrada = 'Rostro'
        AND cp.tracking_id IS NOT NULL
        AND cp.tracking_id = rk_tid.tracking_id
    LEFT JOIN placas_conocidas pk
        ON cp.tipo_entrada = 'Placa'
        AND cp.numero_placa IS NOT NULL
        AND cp.numero_placa = pk.numero_placa
`;

// ── GET /registro/:id ─────────────────────────────────────────────────────────
app.get('/registro/:id', async (req, res) => {
    try {
        const rows = await q(PERSONA_SELECT + ' WHERE cp.id = ?', [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'No encontrado' });
        res.json(rows[0]);
    } catch(err) { console.error('Error /registro/:id:', err.message); res.status(500).json({ error: 'Error' }); }
});

// ── DEBUG temporal ─────────────────────────────────────────────────────────────
app.get('/debug/raw/:id', async (req, res) => {
    try {
        const rows = await q('SELECT id, categoria, tracking_id, rostro_id FROM conteo_peatonal WHERE id=?', [req.params.id]);
        res.json(rows[0] || {});
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/actividad-hoy ───────────────────────────────────────────────────
// Devuelve array de 24 posiciones [hora0..hora23] con conteo de capturas de HOY
app.get('/api/actividad-hoy', async (req, res) => {
    try {
        const rows = await q(`
            SELECT HOUR(fecha_hora) AS hora, COUNT(*) AS n
            FROM conteo_peatonal
            WHERE DATE(fecha_hora) = CURDATE()
            GROUP BY HOUR(fecha_hora)
        `);
        const data = new Array(24).fill(0);
        rows.forEach(r => { data[Number(r.hora)] = Number(r.n); });
        res.json(data);
    } catch { res.status(500).json({ error: 'Error actividad-hoy' }); }
});

// ── GET /api/dashboard-data ──────────────────────────────────────────────────
app.get('/api/dashboard-data', async (req, res) => {
    const { categoria, modulo, desde, hasta, hora_ini, hora_fin } = req.query;

    // Builds the categoria fragment. Unknowns must also catch NULL/empty rows.
    // pre = column prefix ('cp.' for aliased query, '' for direct table query)
    function catFrag(pre, params) {
        if (categoria === 'Rostro_Desconocido')
            return ` AND ${pre}tipo_entrada = 'Rostro' AND (${pre}categoria = 'Rostro_Desconocido' OR ${pre}categoria IS NULL OR ${pre}categoria = '')`;
        if (categoria === 'Placa_Desconocida')
            return ` AND ${pre}tipo_entrada = 'Placa' AND (${pre}categoria = 'Placa_Desconocida' OR ${pre}categoria IS NULL OR ${pre}categoria = '')`;
        if (categoria && categoria !== 'Todos') { params.push(categoria); return ` AND ${pre}categoria = ?`; }
        return '';
    }

    // Registros (PERSONA_SELECT uses cp. alias)
    let where = ' WHERE 1=1';
    const rp = [];
    where += catFrag('cp.', rp);
    if (modulo    && modulo !== 'Todos') { where += ' AND cp.modulo = ?';        rp.push(modulo); }
    if (desde)    { where += ' AND DATE(cp.fecha_hora) >= ?';                    rp.push(desde); }
    if (hasta)    { where += ' AND DATE(cp.fecha_hora) <= ?';                    rp.push(hasta); }
    if (hora_ini) { where += ' AND TIME(cp.fecha_hora) >= ?';                    rp.push(hora_ini + ':00'); }
    if (hora_fin) { where += ' AND TIME(cp.fecha_hora) <= ?';                    rp.push(hora_fin + ':59'); }

    // Actividad chart (direct table, defaults to today)
    let aWhere = ' WHERE 1=1';
    const ap = [];
    aWhere += catFrag('', ap);
    if (modulo    && modulo !== 'Todos') { aWhere += ' AND modulo = ?';           ap.push(modulo); }
    if (desde)    { aWhere += ' AND DATE(fecha_hora) >= ?';                       ap.push(desde); }
    if (hasta)    { aWhere += ' AND DATE(fecha_hora) <= ?';                       ap.push(hasta); }
    if (!desde && !hasta) { aWhere += ' AND DATE(fecha_hora) = CURDATE()'; }
    if (hora_ini) { aWhere += ' AND TIME(fecha_hora) >= ?';                       ap.push(hora_ini + ':00'); }
    if (hora_fin) { aWhere += ' AND TIME(fecha_hora) <= ?';                       ap.push(hora_fin + ':59'); }

    // Counts: all-time, category+modulo only, DISTINCT on unique entity identifiers
    let cWhere = ' WHERE 1=1';
    const cp = [];
    cWhere += catFrag('', cp);
    if (modulo && modulo !== 'Todos') { cWhere += ' AND modulo = ?'; cp.push(modulo); }

    try {
        const [registros, actRows, [cntRow]] = await Promise.all([
            q(PERSONA_SELECT + where + ' ORDER BY cp.fecha_hora DESC LIMIT 200', rp),
            q(`SELECT HOUR(fecha_hora) AS hora, COUNT(*) AS n FROM conteo_peatonal${aWhere} GROUP BY HOUR(fecha_hora)`, ap),
            q(`SELECT
                COUNT(DISTINCT CASE WHEN categoria='Rostro_Conocido'
                    THEN COALESCE(rostro_id, tracking_id) END) AS rc,
                COUNT(DISTINCT CASE WHEN categoria='Rostro_Desconocido'
                    OR (tipo_entrada='Rostro' AND (categoria IS NULL OR categoria=''))
                    THEN COALESCE(tracking_id, id) END) AS rd,
                COUNT(DISTINCT CASE WHEN categoria='Placa_Conocida'
                    THEN numero_placa END) AS pc,
                COUNT(DISTINCT CASE WHEN categoria='Placa_Desconocida'
                    OR (tipo_entrada='Placa' AND (categoria IS NULL OR categoria=''))
                    THEN COALESCE(tracking_id, id) END) AS pd
                FROM conteo_peatonal${cWhere}`, cp)
        ]);
        const actividad = new Array(24).fill(0);
        actRows.forEach(r => { actividad[Number(r.hora)] = Number(r.n); });
        const counts = {
            rc: Number(cntRow.rc || 0), rd: Number(cntRow.rd || 0),
            pc: Number(cntRow.pc || 0), pd: Number(cntRow.pd || 0)
        };
        res.json({ registros, actividad, counts });
    } catch(err) {
        console.error('Error /api/dashboard-data:', err.message);
        res.status(500).json({ error: 'Error dashboard-data' });
    }
});

// ── GET /api/exportar-csv ────────────────────────────────────────────────────
app.get('/api/exportar-csv', async (req, res) => {
    const { categoria, modulo, desde, hasta, hora_ini, hora_fin } = req.query;

    let sql = PERSONA_SELECT + ' WHERE 1=1';
    const params = [];
    if (categoria && categoria !== 'Todos') { sql += ' AND cp.categoria = ?'; params.push(categoria); }
    if (modulo    && modulo    !== 'Todos') { sql += ' AND cp.modulo = ?';    params.push(modulo); }
    if (desde) { sql += ' AND DATE(cp.fecha_hora) >= ?'; params.push(desde); }
    if (hasta) { sql += ' AND DATE(cp.fecha_hora) <= ?'; params.push(hasta); }
    if (hora_ini) { sql += ' AND TIME(cp.fecha_hora) >= ?';     params.push(hora_ini + ':00'); }
    if (hora_fin) { sql += ' AND TIME(cp.fecha_hora) <= ?';     params.push(hora_fin + ':59'); }
    sql += ' ORDER BY cp.fecha_hora DESC LIMIT 10000';

    try {
        const rows = await q(sql, params);
        const esc = v => `"${String(v || '').replace(/"/g, '""')}"`;
        const header = 'ID,Tipo,Categoría,Módulo,Nombre/Placa,Propietario,Num_Control,Cargo,Fecha,Hora';
        const lines = [header, ...rows.map(r => {
            const f  = new Date(r.fecha_registro);
            const fd = `${f.getFullYear()}-${String(f.getMonth()+1).padStart(2,'0')}-${String(f.getDate()).padStart(2,'0')}`;
            const ft = `${String(f.getHours()).padStart(2,'0')}:${String(f.getMinutes()).padStart(2,'0')}:${String(f.getSeconds()).padStart(2,'0')}`;
            return [r.id, esc(r.tipo_entrada), esc(r.categoria || ''), esc(r.modulo),
                    esc(r.nombre || r.numero_placa || ''), esc(r.propietario || ''),
                    esc(r.num_control || ''), esc(r.cargo || ''), fd, ft].join(',');
        })];
        const stamp = new Date().toISOString().slice(0,10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="Reporte_${stamp}.csv"`);
        res.send('﻿' + lines.join('\r\n'));
    } catch(err) { console.error('Error /api/exportar-csv:', err.message); res.status(500).json({ error: 'Error CSV' }); }
});

// ── GET /registros ───────────────────────────────────────────────────────────
app.get('/registros', async (req, res) => {
    const { categoria, tipo, limit = 50 } = req.query;

    let sql = PERSONA_SELECT + ' WHERE 1=1';
    const params = [];
    if (categoria) { sql += ' AND cp.categoria = ?'; params.push(categoria); }
    if (tipo)      { sql += ' AND cp.tipo_entrada = ?'; params.push(tipo); }
    sql += ' ORDER BY cp.fecha_hora DESC LIMIT ?';
    params.push(Math.min(parseInt(limit, 10) || 50, 200));

    try {
        res.json(await q(sql, params));
    } catch(err) { console.error('Error /registros:', err.message); res.status(500).json({ error: 'Fallo al leer BD' }); }
});

// ── PUT /marcar-conocido/:id ─────────────────────────────────────────────────
app.put('/marcar-conocido/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, tipo_carro, placa, numero_placa, propietario } = req.body;

    try {
        const rows = await q('SELECT * FROM conteo_peatonal WHERE id = ?', [id]);
        if (!rows.length) return res.status(404).json({ error: 'No encontrado' });

        const reg = rows[0];
        let nuevaCategoria;

        if (reg.tipo_entrada === 'Rostro') {
            const { tipo_persona, num_control, cargo } = req.body;
            if (!nombre) return res.status(400).json({ error: 'Falta nombre' });
            const ins = await q(
                `INSERT INTO rostros_conocidos (nombre, tracking_id, tipo_carro, placa, tipo_persona, num_control, cargo)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), tipo_carro=VALUES(tipo_carro), placa=VALUES(placa),
                   tipo_persona=VALUES(tipo_persona), num_control=VALUES(num_control), cargo=VALUES(cargo)`,
                [nombre, reg.tracking_id, tipo_carro || null, placa || null,
                 tipo_persona || null, num_control || null, cargo || null]
            );

            // Resolver rostroId de forma robusta:
            // 1) insertId en INSERT exitoso (o en DUPLICATE KEY en algunas versiones de mysql2)
            // 2) Buscar por tracking_id exacto (más confiable)
            // 3) Fallback por nombre
            let rostroId = ins.insertId || 0;
            if (!rostroId && reg.tracking_id != null) {
                const r = await q('SELECT id FROM rostros_conocidos WHERE tracking_id=? LIMIT 1', [reg.tracking_id]);
                if (r.length) rostroId = r[0].id;
            }
            if (!rostroId) {
                const r = await q('SELECT id FROM rostros_conocidos WHERE nombre=? ORDER BY registrado DESC LIMIT 1', [nombre]);
                if (r.length) rostroId = r[0].id;
            }
            if (!rostroId) console.error(`WARN: rostroId no resuelto para "${nombre}" tid=${reg.tracking_id}`);

            nuevaCategoria = 'Rostro_Conocido';
            if (reg.tracking_id != null) {
                // Tracking_id conocido: JOIN directo sobre todas las capturas del mismo ID
                await q(`
                    UPDATE conteo_peatonal cp
                    JOIN rostros_conocidos rk ON rk.tracking_id = cp.tracking_id
                    SET cp.categoria = ?, cp.rostro_id = rk.id
                    WHERE cp.tracking_id = ? AND cp.tipo_entrada = 'Rostro'
                `, [nuevaCategoria, reg.tracking_id]);
            } else {
                // Tracking_id NULL: agrupar por cámara + ventana ±20s alrededor de esta captura
                await q(`
                    UPDATE conteo_peatonal
                    SET categoria = ?, rostro_id = ?
                    WHERE tipo_entrada = 'Rostro'
                      AND tracking_id IS NULL
                      AND modulo = ?
                      AND fecha_hora BETWEEN DATE_SUB(?, INTERVAL 20 SECOND)
                                        AND DATE_ADD(?, INTERVAL 20 SECOND)
                `, [nuevaCategoria, rostroId, reg.modulo, reg.fecha_hora, reg.fecha_hora]);
            }
        } else {
            const numPlaca = numero_placa || String(reg.tracking_id || id);
            await q(
                `INSERT INTO placas_conocidas (numero_placa, propietario, tipo_carro)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE propietario = VALUES(propietario), tipo_carro = VALUES(tipo_carro)`,
                [numPlaca, propietario || null, req.body.tipo_carro || null]
            );
            nuevaCategoria = 'Placa_Conocida';
            await q('UPDATE conteo_peatonal SET categoria=?, numero_placa=? WHERE id=?', [nuevaCategoria, numPlaca, id]);
        }
        io.emit('deteccion_actualizada', { id: parseInt(id), tracking_id: reg.tracking_id ?? null, categoria: nuevaCategoria });
        res.json({ mensaje: 'Marcado como conocido', categoria: nuevaCategoria });

    } catch(err) {
        console.error('Error /marcar-conocido:', err);
        res.status(500).json({ error: 'Fallo al actualizar' });
    }
});

// ── POST /registrar-rostro ───────────────────────────────────────────────────
app.post('/registrar-rostro', async (req, res) => {
    const { nombre, tracking_id, tipo_carro, placa, tipo_persona, num_control, cargo } = req.body;
    if (!nombre || tracking_id == null) return res.status(400).json({ error: 'Faltan nombre o tracking_id' });
    try {
        const result = await q(
            `INSERT INTO rostros_conocidos (nombre, tracking_id, tipo_carro, placa, tipo_persona, num_control, cargo)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), tipo_carro=VALUES(tipo_carro), placa=VALUES(placa),
               tipo_persona=VALUES(tipo_persona), num_control=VALUES(num_control), cargo=VALUES(cargo)`,
            [nombre, tracking_id, tipo_carro || null, placa || null,
             tipo_persona || null, num_control || null, cargo || null]
        );
        res.json({ mensaje: 'Rostro registrado', id: result.insertId });
    } catch { res.status(500).json({ error: 'Error al registrar' }); }
});

// ── POST /registrar-placa ────────────────────────────────────────────────────
app.post('/registrar-placa', async (req, res) => {
    const { numero_placa, propietario, tipo_carro } = req.body;
    if (!numero_placa) return res.status(400).json({ error: 'Falta numero_placa' });
    try {
        const result = await q(
            `INSERT INTO placas_conocidas (numero_placa, propietario, tipo_carro)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE propietario = VALUES(propietario), tipo_carro = VALUES(tipo_carro)`,
            [numero_placa, propietario || null, tipo_carro || null]
        );
        res.json({ mensaje: 'Placa registrada', id: result.insertId });
    } catch { res.status(500).json({ error: 'Error al registrar' }); }
});

// ── GET /conocidos ───────────────────────────────────────────────────────────
app.get('/conocidos/rostros', async (req, res) => {
    try { res.json(await q('SELECT * FROM rostros_conocidos ORDER BY registrado DESC')); }
    catch { res.status(500).json({ error: 'Error' }); }
});

app.get('/conocidos/placas', async (req, res) => {
    try { res.json(await q('SELECT * FROM placas_conocidas ORDER BY registrado DESC')); }
    catch { res.status(500).json({ error: 'Error' }); }
});

// ── DELETE /conocidos ─────────────────────────────────────────────────────────
app.delete('/conocidos/rostro/:id', async (req, res) => {
    try { await q('DELETE FROM rostros_conocidos WHERE id = ?', [req.params.id]); res.json({ ok: true }); }
    catch { res.status(500).json({ error: 'Error' }); }
});

app.delete('/conocidos/placa/:id', async (req, res) => {
    try { await q('DELETE FROM placas_conocidas WHERE id = ?', [req.params.id]); res.json({ ok: true }); }
    catch { res.status(500).json({ error: 'Error' }); }
});

// ── MAIN ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;

// Escuchar PRIMERO — Railway necesita ver el puerto activo de inmediato
server.listen(PORT, '0.0.0.0', () => {
    console.log(`KERNEL ACTIVO · Puerto ${PORT}`);
    // DB init después de que el puerto ya está abierto
    initDB()
        .then(() => console.log('Sistema listo.'))
        .catch(err => console.error('Error DB init:', err.message));
});
