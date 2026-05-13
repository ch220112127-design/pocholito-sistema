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
const pool = mysql.createPool({
    host:     process.env.MYSQLHOST     || process.env.DB_HOST     || 'localhost',
    port:     process.env.MYSQLPORT     || process.env.DB_PORT     || 3306,
    user:     process.env.MYSQLUSER     || process.env.DB_USER     || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || 'root',
    database: process.env.MYSQLDATABASE || process.env.DB_NAME     || 'sistema_conteo',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit:      0
});

const q = (sql, params) => new Promise((resolve, reject) =>
    pool.query(sql, params || [], (err, rows) => err ? reject(err) : resolve(rows))
);

// ── INIT DB ──────────────────────────────────────────────────────────────────
async function initDB() {
    await q(`CREATE TABLE IF NOT EXISTS rostros_conocidos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        nombre      VARCHAR(100) NOT NULL,
        tracking_id INT UNIQUE,
        tipo_carro  VARCHAR(50)  DEFAULT NULL,
        placa       VARCHAR(20)  DEFAULT NULL,
        registrado  DATETIME DEFAULT NOW()
    )`);
    await q(`ALTER TABLE rostros_conocidos ADD COLUMN IF NOT EXISTS tipo_carro VARCHAR(50)  DEFAULT NULL`);
    await q(`ALTER TABLE rostros_conocidos ADD COLUMN IF NOT EXISTS placa      VARCHAR(20)  DEFAULT NULL`);
    await q(`CREATE TABLE IF NOT EXISTS placas_conocidas (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        numero_placa VARCHAR(20) NOT NULL UNIQUE,
        propietario  VARCHAR(100),
        registrado   DATETIME DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS conteo_peatonal (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        modulo      VARCHAR(100) DEFAULT NULL,
        tipo_entrada VARCHAR(30) DEFAULT NULL,
        foto        VARCHAR(255) DEFAULT NULL,
        categoria   VARCHAR(30)  DEFAULT NULL,
        tracking_id INT          DEFAULT NULL,
        fecha_hora  DATETIME     DEFAULT NOW()
    )`);
    await q(`ALTER TABLE conteo_peatonal ADD COLUMN IF NOT EXISTS foto        VARCHAR(255) DEFAULT NULL`);
    await q(`ALTER TABLE conteo_peatonal ADD COLUMN IF NOT EXISTS categoria   VARCHAR(30)  DEFAULT NULL`);
    await q(`ALTER TABLE conteo_peatonal ADD COLUMN IF NOT EXISTS tracking_id INT          DEFAULT NULL`);
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
app.get('/stats', async (req, res) => {
    try {
        const rows = await q(`SELECT categoria, COUNT(*) as total FROM conteo_peatonal GROUP BY categoria`);
        const stats = { Rostro_Conocido: 0, Rostro_Desconocido: 0, Placa_Conocida: 0, Placa_Desconocida: 0 };
        rows.forEach(r => { if (r.categoria in stats) stats[r.categoria] = Number(r.total); });
        res.json(stats);
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

// ── GET /registros ───────────────────────────────────────────────────────────
app.get('/registros', async (req, res) => {
    const { categoria, tipo, limit = 50 } = req.query;

    let sql = `
        SELECT cp.id, cp.modulo, cp.tipo_entrada, cp.foto, cp.categoria,
               cp.tracking_id, cp.fecha_hora AS fecha_registro,
               rk.nombre, rk.tipo_carro, rk.placa AS placa_carro,
               pk.numero_placa, pk.propietario
        FROM conteo_peatonal cp
        LEFT JOIN rostros_conocidos rk
            ON cp.tracking_id = rk.tracking_id AND cp.tipo_entrada = 'Rostro'
        LEFT JOIN placas_conocidas pk
            ON cp.tracking_id = CAST(pk.numero_placa AS UNSIGNED) AND cp.tipo_entrada = 'Placa'
        WHERE 1=1
    `;
    const params = [];
    if (categoria) { sql += ' AND cp.categoria = ?'; params.push(categoria); }
    if (tipo)      { sql += ' AND cp.tipo_entrada = ?'; params.push(tipo); }
    sql += ' ORDER BY cp.fecha_hora DESC LIMIT ?';
    params.push(Math.min(parseInt(limit, 10) || 50, 200));

    try {
        res.json(await q(sql, params));
    } catch { res.status(500).json({ error: 'Fallo al leer BD' }); }
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
            if (!nombre) return res.status(400).json({ error: 'Falta nombre' });
            await q(
                `INSERT INTO rostros_conocidos (nombre, tracking_id, tipo_carro, placa)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), tipo_carro=VALUES(tipo_carro), placa=VALUES(placa)`,
                [nombre, reg.tracking_id, tipo_carro || null, placa || null]
            );
            nuevaCategoria = 'Rostro_Conocido';
        } else {
            const numPlaca = numero_placa || String(reg.tracking_id || id);
            await q(
                'INSERT INTO placas_conocidas (numero_placa, propietario) VALUES (?, ?) ON DUPLICATE KEY UPDATE propietario = ?',
                [numPlaca, propietario || null, propietario || null]
            );
            nuevaCategoria = 'Placa_Conocida';
        }

        await q('UPDATE conteo_peatonal SET categoria = ? WHERE id = ?', [nuevaCategoria, id]);
        io.emit('deteccion_actualizada', { id: parseInt(id), categoria: nuevaCategoria });
        res.json({ mensaje: 'Marcado como conocido', categoria: nuevaCategoria });

    } catch(err) {
        console.error('Error /marcar-conocido:', err);
        res.status(500).json({ error: 'Fallo al actualizar' });
    }
});

// ── POST /registrar-rostro ───────────────────────────────────────────────────
app.post('/registrar-rostro', async (req, res) => {
    const { nombre, tracking_id, tipo_carro, placa } = req.body;
    if (!nombre || tracking_id == null) return res.status(400).json({ error: 'Faltan nombre o tracking_id' });
    try {
        const result = await q(
            `INSERT INTO rostros_conocidos (nombre, tracking_id, tipo_carro, placa)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), tipo_carro=VALUES(tipo_carro), placa=VALUES(placa)`,
            [nombre, tracking_id, tipo_carro || null, placa || null]
        );
        res.json({ mensaje: 'Rostro registrado', id: result.insertId });
    } catch { res.status(500).json({ error: 'Error al registrar' }); }
});

// ── POST /registrar-placa ────────────────────────────────────────────────────
app.post('/registrar-placa', async (req, res) => {
    const { numero_placa, propietario } = req.body;
    if (!numero_placa) return res.status(400).json({ error: 'Falta numero_placa' });
    try {
        const result = await q(
            'INSERT INTO placas_conocidas (numero_placa, propietario) VALUES (?, ?) ON DUPLICATE KEY UPDATE propietario = ?',
            [numero_placa, propietario || null, propietario || null]
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

initDB().then(() => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log('\n═══════════════════════════════════════');
        console.log(`  KERNEL ACTIVO · Puerto ${PORT}`);
        console.log('  WebSocket (Socket.io) habilitado');
        console.log('═══════════════════════════════════════\n');
    });
}).catch(err => {
    console.error('Error iniciando server:', err);
    process.exit(1);
});
