const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: [
    'http://localhost:5173',
    /\.vercel\.app$/,
  ],
  credentials: true,
}));
app.use(express.json());

// ── Konfigurasi Cloudinary ────────────────────────────────────
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Multer Storage ke Cloudinary ─────────────────────────────
const storage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
        folder:         'univora',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        transformation: [{ width: 1200, crop: 'limit', quality: 'auto' }],
        public_id: `univora_${Date.now()}`,
    }),
});

const fileFilter = (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) {
        cb(null, true);
    } else {
        cb(new Error('Hanya file gambar (jpg, png, webp) yang diizinkan.'));
    }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// ── Koneksi MySQL: createPool agar tidak crash saat idle di Railway ────────
const db = mysql.createPool({
    host:               process.env.DB_HOST,
    port:               parseInt(process.env.DB_PORT) || 3306,
    user:               process.env.DB_USER,
    password:           process.env.DB_PASSWORD,
    database:           process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    enableKeepAlive:    true,
    keepAliveInitDelay: 0,
});

// ── Error handler global pool ─────────────────────────────────────────────
// Tangkap error 'inactivity disconnect' agar server tidak crash
db.on('error', (err) => {
    console.error('MySQL pool error (ditangani):', err.code, err.message);
    // Pool akan otomatis buat koneksi baru — tidak perlu reconnect manual
});

// ── Keep-alive ping setiap 5 menit ───────────────────────────────────────
// Mencegah Railway MySQL memutus koneksi karena idle (wait_timeout)
setInterval(() => {
    db.query('SELECT 1', (err) => {
        if (err) console.error('Keep-alive ping gagal:', err.message);
        else console.log('Keep-alive ping OK');
    });
}, 5 * 60 * 1000); // setiap 5 menit

// ── Test koneksi + migrasi tabel ─────────────────────────────────────────
db.getConnection((err, connection) => {
    if (err) { console.error('Database gagal terhubung:', err); return; }
    console.log('Database MySQL Berhasil Terhubung!');
    connection.release();

        // ── Tabel kategori referensi (master) ─────────────────────────────
        db.query(`
            CREATE TABLE IF NOT EXISTS kategori_kuliner (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nama VARCHAR(100) NOT NULL UNIQUE
            ) ENGINE=InnoDB
        `, () => {
            const masterKategori = [
                'Warteg/Warung Makan', 'Caffe/Burjo', 'Fast Food',
                'Makanan Berkuah', 'Street Food',
                'Kuliner Nusantara', 'Kuliner Oriental', 'Dessert/Manisan'
            ];
            masterKategori.forEach(k => db.query('INSERT IGNORE INTO kategori_kuliner (nama) VALUES (?)', [k]));
            console.log('Tabel kategori_kuliner siap.');
        });

        // ── Tabel relasi tempat_makan ↔ kategori (many-to-many) ──────────
        db.query(`
            CREATE TABLE IF NOT EXISTS tempat_makan_kategori (
                tempat_makan_id INT NOT NULL,
                kategori_id     INT NOT NULL,
                PRIMARY KEY (tempat_makan_id, kategori_id),
                FOREIGN KEY (tempat_makan_id) REFERENCES tempat_makan(id) ON DELETE CASCADE,
                FOREIGN KEY (kategori_id)     REFERENCES kategori_kuliner(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `, () => console.log('Tabel tempat_makan_kategori siap.'));

        // ── Tabel: foto_tempat (galeri foto per tempat makan) ─────────────
        db.query(`
            CREATE TABLE IF NOT EXISTS foto_tempat (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                tempat_makan_id INT NOT NULL,
                user_id         INT,
                tipe            ENUM('menu','galeri') DEFAULT 'galeri',
                url             VARCHAR(500) NOT NULL,
                keterangan      VARCHAR(255) DEFAULT NULL,
                created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (tempat_makan_id) REFERENCES tempat_makan(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id)         REFERENCES users(id) ON DELETE SET NULL
            ) ENGINE=InnoDB
        `, () => console.log('Tabel foto_tempat siap.'));

        // ── Tabel: favorit_tempat (user bookmarks) ───────────────────────
        db.query(`
            CREATE TABLE IF NOT EXISTS favorit_tempat (
                id              INT AUTO_INCREMENT PRIMARY KEY,
                user_id         INT NOT NULL,
                tempat_makan_id INT NOT NULL,
                created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_user_place (user_id, tempat_makan_id),
                FOREIGN KEY (user_id)         REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (tempat_makan_id) REFERENCES tempat_makan(id) ON DELETE CASCADE
            ) ENGINE=InnoDB
        `, () => console.log('Tabel favorit_tempat siap.'));

        // ── MIGRASI: Tambah kolom status di tabel users jika belum ada ──────
        db.query("SHOW COLUMNS FROM users LIKE 'status'", (err, cols) => {
            if (!err && cols.length === 0) {
                db.query(
                    "ALTER TABLE users ADD COLUMN status ENUM('Aktif','Diblokir') NOT NULL DEFAULT 'Aktif' AFTER role",
                    (err2) => {
                        if (err2) console.error('Gagal migrasi kolom status users:', err2);
                        else console.log('Kolom status berhasil ditambahkan ke tabel users.');
                    }
                );
            } else { console.log('Kolom status users sudah ada.'); }
        });

        // ── MIGRASI: Tambah kolom foto_profil ke tabel users ───────────────
        db.query("ALTER TABLE users ADD COLUMN foto_profil VARCHAR(500) DEFAULT NULL", (errFp) => {
            if (errFp && errFp.code !== 'ER_DUP_FIELDNAME') console.error('Gagal migrasi kolom foto_profil:', errFp);
        });

        // ── MIGRASI: Tambah kolom jam_buka & jam_tutup jika belum ada ─────
        db.query("SHOW COLUMNS FROM tempat_makan LIKE 'jam_buka'", (err, cols) => {
            if (!err && cols.length === 0) {
                db.query(`ALTER TABLE tempat_makan
                    ADD COLUMN jam_buka  VARCHAR(5) DEFAULT '08:00' AFTER banner_img,
                    ADD COLUMN jam_tutup VARCHAR(5) DEFAULT '21:00' AFTER jam_buka
                `, (err2) => {
                    if (err2) console.error('Gagal migrasi kolom jam:', err2);
                    else console.log('Kolom jam_buka & jam_tutup berhasil ditambahkan.');
                });
            } else {
                console.log('Kolom jam_buka & jam_tutup sudah ada.');
            }
        });
}); // tutup db.getConnection

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || "KUNCI_RAHASIA_UNIVORA_TA";

// =========================================================================
// AUTH
// =========================================================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { nama_lengkap, email, password } = req.body;
        const hashed = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (nama_lengkap, email, password) VALUES (?, ?, ?)', [nama_lengkap, email, hashed], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Email sudah digunakan!' });
            return res.status(201).json({ success: true, message: 'Akun berhasil dibuat! Silakan masuk.' });
        });
    } catch (e) { return res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        if (!results.length) return res.status(400).json({ success: false, message: 'Email tidak terdaftar!' });
        const user = results[0];
        const isMatch = (user.password.startsWith('$2b$') || user.password.startsWith('$2a$'))
            ? await bcrypt.compare(password, user.password)
            : password === user.password;
        if (!isMatch) return res.status(400).json({ success: false, message: 'Password salah!' });
        // Cek status blokir
        const userStatus = user.status || 'Aktif';
        if (userStatus === 'Diblokir') return res.status(403).json({ success: false, message: 'Akun Anda telah diblokir oleh Administrator. Hubungi admin untuk informasi lebih lanjut.' });
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1d' });
        return res.json({ success: true, token, user: {
            id:            user.id,
            nama_lengkap:  user.nama_lengkap,
            email:         user.email,
            nomor_telepon: user.nomor_telepon || null,
            foto_profil:   user.foto_profil   || null,
            role:          user.role          || 'Mahasiswa',
        }});
    });
});

// =========================================================================
// PROFILE — GET & UPDATE USER
// =========================================================================

// GET /api/users/:id — ambil data profil terbaru
app.get('/api/users/:id', (req, res) => {
    const { id } = req.params;
    db.query(
        'SELECT id, nama_lengkap, email, nomor_telepon, foto_profil, role, created_at FROM users WHERE id = ?',
        [id],
        (err, results) => {
            if (err)             return res.status(500).json({ success: false, message: 'Server error.' });
            if (!results.length) return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
            return res.json({ success: true, data: results[0] });
        }
    );
});

// PUT /api/users/:id — update nama lengkap & nomor telepon
app.put('/api/users/:id', (req, res) => {
    const { id } = req.params;
    const { nama_lengkap, nomor_telepon } = req.body;
    if (!nama_lengkap || !nama_lengkap.trim()) {
        return res.status(400).json({ success: false, message: 'Nama lengkap wajib diisi.' });
    }
    db.query(
        'UPDATE users SET nama_lengkap = ?, nomor_telepon = ? WHERE id = ?',
        [nama_lengkap.trim(), nomor_telepon?.trim() || null, id],
        (err, result) => {
            if (err)              return res.status(500).json({ success: false, message: 'Gagal memperbarui profil.' });
            if (!result.affectedRows) return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
            db.query(
                'SELECT id, nama_lengkap, email, nomor_telepon, foto_profil, role FROM users WHERE id = ?',
                [id],
                (err2, rows) => {
                    if (err2 || !rows.length) return res.json({ success: true, message: 'Profil berhasil diperbarui.' });
                    return res.json({ success: true, message: 'Profil berhasil diperbarui.', user: rows[0] });
                }
            );
        }
    );
});

// POST /api/users/:id/avatar — upload foto profil
app.post('/api/users/:id/avatar', upload.single('foto'), (req, res) => {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ success: false, message: 'File foto tidak ditemukan.' });
    const fotoUrl = req.file.path; // Cloudinary otomatis return URL lengkap di req.file.path
    db.query('UPDATE users SET foto_profil = ? WHERE id = ?', [fotoUrl, id], (err, result) => {
        if (err)                  return res.status(500).json({ success: false, message: 'Gagal menyimpan foto.' });
        if (!result.affectedRows) return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
        return res.json({ success: true, message: 'Foto profil berhasil diperbarui.', foto_url: fotoUrl });
    });
});

// =========================================================================
// MASTER KATEGORI
// =========================================================================

app.get('/api/kategori', (req, res) => {
    db.query('SELECT * FROM kategori_kuliner ORDER BY nama ASC', (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil kategori' });
        return res.json({ success: true, data: results });
    });
});

// =========================================================================
// KOTA & KAMPUS
// =========================================================================

app.get('/api/cities', (req, res) => {
    db.query("SELECT * FROM cities ORDER BY nama_kota ASC", (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil data kota' });
        return res.json({ success: true, data: results });
    });
});

app.get('/api/campus/selection', (req, res) => {
    db.query(`SELECT u.id AS university_id, u.nama_universitas, c.nama_kota FROM universities u JOIN cities c ON u.city_id = c.id ORDER BY c.nama_kota, u.nama_universitas`, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil data wilayah' });
        return res.json({ success: true, data: results });
    });
});

app.get('/api/campus/by-city', (req, res) => {
    const cityId = req.query.city_id;
    if (!cityId) return res.status(400).json({ success: false, message: 'Parameter city_id dibutuhkan' });
    db.query(`SELECT DISTINCT u.id AS university_id, u.nama_universitas, c.nama_kota FROM universities u JOIN cities c ON u.city_id = c.id WHERE u.city_id = ? ORDER BY u.nama_universitas ASC`, [cityId], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil data kampus' });
        return res.json({ success: true, data: results });
    });
});

// =========================================================================
// TEMPAT MAKAN
// =========================================================================

// Helper: cek apakah tempat makan sedang buka berdasarkan jam WIB saat ini
const hitungStatusBuka = (jamBuka, jamTutup) => {
    if (!jamBuka || !jamTutup) return { buka: true, label: 'Buka' };

    const now = new Date();
    // Konversi ke WIB (UTC+7)
    const wibOffset = 7 * 60;
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const wibMinutes = (utcMinutes + wibOffset) % (24 * 60);

    const [bH, bM] = jamBuka.split(':').map(Number);
    const [tH, tM] = jamTutup.split(':').map(Number);
    const bukaTotal  = bH * 60 + bM;
    const tutupTotal = tH * 60 + tM;

    let buka;
    if (bukaTotal <= tutupTotal) {
        // Jam normal, tidak lintas tengah malam
        buka = wibMinutes >= bukaTotal && wibMinutes < tutupTotal;
    } else {
        // Lintas tengah malam (misal: 20:00 - 02:00)
        buka = wibMinutes >= bukaTotal || wibMinutes < tutupTotal;
    }

    return { buka, label: buka ? 'Buka' : 'Tutup' };
};

// Helper: ambil kategori per tempat makan (array nama)
const getKategoriByPlaceId = (placeId, callback) => {
    db.query(`
        SELECT k.nama FROM tempat_makan_kategori tmk
        JOIN kategori_kuliner k ON tmk.kategori_id = k.id
        WHERE tmk.tempat_makan_id = ?
        ORDER BY k.nama ASC
    `, [placeId], (err, rows) => {
        callback(err, rows ? rows.map(r => r.nama) : []);
    });
};

// Helper: enrichment — tambah kategori_list & status buka ke satu spot
const enrichSpot = (spot) => {
    const status = hitungStatusBuka(spot.jam_buka, spot.jam_tutup);
    return { ...spot, status_buka: status.buka, status_label: status.label };
};

// GET /api/places — list dengan filter kampus, kategori, & search
app.get('/api/places', (req, res) => {
    const { univ_id, university_id, category, search } = req.query;
    const univId = univ_id || university_id;

    let query = `
        SELECT DISTINCT tm.*,
            ROUND(COALESCE(
                (SELECT AVG(u2.rating) FROM ulasan u2
                 WHERE u2.tempat_makan_id = tm.id
                   AND (u2.status_moderasi = 'Disetujui' OR u2.status_moderasi IS NULL)),
                0
            ), 1) AS avg_rating,
            (SELECT COUNT(*) FROM ulasan u3
             WHERE u3.tempat_makan_id = tm.id
               AND (u3.status_moderasi = 'Disetujui' OR u3.status_moderasi IS NULL)
            ) AS review_count
        FROM tempat_makan tm
        ${category && category !== 'Semua Kategori'
            ? `JOIN tempat_makan_kategori tmk ON tm.id = tmk.tempat_makan_id
               JOIN kategori_kuliner k ON tmk.kategori_id = k.id`
            : ''}
        WHERE tm.status_verifikasi = 'Disetujui'
    `;
    const params = [];

    if (univId) { query += ' AND tm.university_id = ?'; params.push(univId); }
    if (category && category !== 'Semua Kategori') {
        query += ' AND k.nama = ?';
        params.push(category);
    }
    if (search && search.trim() !== '') {
        query += ' AND (tm.nama LIKE ? OR tm.deskripsi LIKE ? OR tm.alamat LIKE ?)';
        const sw = `%${search.trim()}%`;
        params.push(sw, sw, sw);
    }
    query += ' ORDER BY tm.id DESC';

    db.query(query, params, (err, results) => {
        if (err) { console.error('DB error GET /api/places:', err); return res.status(500).json({ success: false, message: 'Gagal mengambil data' }); }
        if (!results.length) return res.json({ success: true, data: [] });

        let done = 0;
        const enriched = results.map(spot => enrichSpot({
            ...spot,
            kategori_list: [],
            avg_rating:   parseFloat(spot.avg_rating)  || 0,
            review_count: parseInt(spot.review_count)  || 0,
            latitude:     parseFloat(spot.latitude)    || 0,
            longitude:    parseFloat(spot.longitude)   || 0,
        }));
        enriched.forEach((spot, i) => {
            getKategoriByPlaceId(spot.id, (err2, kategoris) => {
                enriched[i].kategori_list = kategoris;
                enriched[i].kategori = kategoris[0] || spot.kategori || '-';
                if (++done === enriched.length) res.json({ success: true, data: enriched });
            });
        });
    });
});

// GET /api/places/:id — detail + ulasan + kategori + avg_rating lengkap
app.get('/api/places/:id', (req, res) => {
    const placeId = req.params.id;
    db.query(`
        SELECT tm.*,
            ROUND(AVG(ul.rating), 1)  AS avg_rating,
            COUNT(ul.id)              AS review_count
        FROM tempat_makan tm
        LEFT JOIN ulasan ul ON ul.tempat_makan_id = tm.id
            AND (ul.status_moderasi IS NULL OR ul.status_moderasi != 'Ditolak')
        WHERE tm.id = ?
        GROUP BY tm.id
    `, [placeId], (err, placeResults) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error' });
        if (!placeResults.length) return res.status(404).json({ success: false, message: 'Tempat makan tidak ditemukan' });

        const detailWarung = enrichSpot(placeResults[0]);

        getKategoriByPlaceId(placeId, (err2, kategoris) => {
            detailWarung.kategori_list = kategoris;
            detailWarung.kategori = kategoris[0] || detailWarung.kategori || '-';

            db.query("SHOW COLUMNS FROM ulasan LIKE 'status_moderasi'", (err3, cols) => {
                const reviewQuery = (!err3 && cols.length > 0)
                    ? `SELECT ul.id, ul.rating, ul.komentar, ul.foto_ulasan, ul.created_at, us.nama_lengkap, us.foto_profil
                       FROM ulasan ul JOIN users us ON ul.user_id = us.id
                       WHERE ul.tempat_makan_id = ? AND ul.status_moderasi != 'Ditolak' ORDER BY ul.created_at DESC`
                    : `SELECT ul.id, ul.rating, ul.komentar, ul.foto_ulasan, ul.created_at, us.nama_lengkap, us.foto_profil
                       FROM ulasan ul JOIN users us ON ul.user_id = us.id
                       WHERE ul.tempat_makan_id = ? ORDER BY ul.created_at DESC`;

                db.query(reviewQuery, [placeId], (err4, reviewResults) => {
                    if (err4) return res.status(500).json({ success: false, message: 'Gagal mengambil ulasan' });
                    return res.json({ success: true, data: { ...detailWarung, ulasan: reviewResults } });
                });
            });
        });
    });
});

// POST /api/places — Submit tempat makan baru (multi-kategori + jam buka/tutup)
// POST /api/places — cover (field 'foto') + galeri awal (field 'galeri', maks 10)
app.post('/api/places', upload.fields([
    { name: 'foto',   maxCount: 1  },
    { name: 'galeri', maxCount: 10 },
]), (req, res) => {
    const { university_id, user_id, nama, kategori_ids, alamat, deskripsi, harga_min, harga_max, jam_buka, jam_tutup } = req.body;

    let parsedKategoriIds = [];
    try { parsedKategoriIds = JSON.parse(kategori_ids || '[]'); } catch (e) { parsedKategoriIds = []; }
    if (!parsedKategoriIds.length) {
        return res.status(400).json({ success: false, message: 'Pilih minimal 1 kategori.' });
    }

    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const validJamBuka  = jam_buka  && timeRegex.test(jam_buka)  ? jam_buka  : '08:00';
    const validJamTutup = jam_tutup && timeRegex.test(jam_tutup) ? jam_tutup : '21:00';

    // Cover banner: dari field 'foto'
    const coverFile = req.files?.foto?.[0];
    const banner_img = coverFile ? coverFile.path : 'default_warung.jpg'; // coverFile.path = Cloudinary URL

    const firstKategoriId = parsedKategoriIds[0];
    db.query('SELECT nama FROM kategori_kuliner WHERE id = ?', [firstKategoriId], (err, katRows) => {
        const kategoriLama = (katRows && katRows.length) ? katRows[0].nama : 'Lainnya';

        const insertQuery = `
            INSERT INTO tempat_makan
            (university_id, user_id, nama, kategori, alamat, deskripsi, harga_min, harga_max, banner_img, jam_buka, jam_tutup, latitude, longitude, status_verifikasi)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'Diproses')
        `;
        const vals = [
            parseInt(university_id) || 1, parseInt(user_id) || 1,
            (nama || '').trim(), kategoriLama,
            (alamat || '').trim(), (deskripsi || '-').trim(),
            parseInt(harga_min) || 0, parseInt(harga_max) || 0,
            banner_img, validJamBuka, validJamTutup
        ];

        db.query(insertQuery, vals, (err2, result) => {
            if (err2) { console.error('DB Error POST /api/places:', err2); return res.status(500).json({ success: false, message: 'Gagal menyimpan: ' + err2.message }); }

            const newPlaceId = result.insertId;
            const userId = parseInt(user_id) || null;

            // Simpan relasi kategori
            const relRows = parsedKategoriIds.map(kid => [newPlaceId, kid]);
            db.query('INSERT IGNORE INTO tempat_makan_kategori (tempat_makan_id, kategori_id) VALUES ?', [relRows], (err3) => {
                if (err3) console.error('Gagal simpan relasi kategori:', err3);

                // Simpan foto galeri awal jika ada (field 'galeri')
                const galeriFiles = req.files?.galeri || [];
                if (galeriFiles.length > 0) {
                    const fotoRows = galeriFiles.map(f => [
                        newPlaceId, userId, 'galeri',
                        f.path, null // f.path = Cloudinary URL
                    ]);
                    db.query('INSERT INTO foto_tempat (tempat_makan_id, user_id, tipe, url, keterangan) VALUES ?',
                        [fotoRows], (err4) => {
                            if (err4) console.error('Gagal simpan foto galeri awal:', err4);
                        }
                    );
                }

                return res.status(201).json({ success: true, message: 'Rekomendasi tempat makan berhasil dikirim! Mohon tunggu verifikasi admin.' });
            });
        });
    });
});

// =========================================================================
// KOORDINAT / LOCATION
// =========================================================================

// GET /api/places/:id/location — ambil koordinat tempat makan
app.get('/api/places/:id/location', (req, res) => {
    const { id } = req.params;
    db.query('SELECT id, nama, alamat, latitude, longitude FROM tempat_makan WHERE id = ?', [id], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error.' });
        if (!results.length) return res.status(404).json({ success: false, message: 'Tempat makan tidak ditemukan.' });
        const row = results[0];
        const hasCoords = parseFloat(row.latitude) !== 0 || parseFloat(row.longitude) !== 0;
        return res.json({
            success: true,
            data: {
                id: row.id, nama: row.nama, alamat: row.alamat,
                latitude:   hasCoords ? parseFloat(row.latitude)  : null,
                longitude:  hasCoords ? parseFloat(row.longitude) : null,
                has_coords: hasCoords,
            }
        });
    });
});

// PUT /api/places/:id/location — simpan/update koordinat
app.put('/api/places/:id/location', (req, res) => {
    const { id } = req.params;
    const lat = parseFloat(req.body.latitude);
    const lng = parseFloat(req.body.longitude);
    if (isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ success: false, message: 'latitude dan longitude harus berupa angka.' });
    }
    db.query('UPDATE tempat_makan SET latitude = ?, longitude = ? WHERE id = ?', [lat, lng, id], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal menyimpan koordinat.' });
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Tempat makan tidak ditemukan.' });
        return res.json({ success: true, message: 'Koordinat berhasil disimpan.' });
    });
});

// =========================================================================
// GALERI FOTO TEMPAT MAKAN
// =========================================================================

// GET /api/places/:id/photos — ambil semua foto galeri & menu suatu tempat
app.get('/api/places/:id/photos', (req, res) => {
    const placeId = req.params.id;
    db.query(
        `SELECT ft.*, u.nama_lengkap AS nama_uploader
         FROM foto_tempat ft
         LEFT JOIN users u ON ft.user_id = u.id
         WHERE ft.tempat_makan_id = ?
         ORDER BY ft.created_at DESC`,
        [placeId],
        (err, results) => {
            if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil foto.' });
            return res.json({ success: true, data: results });
        }
    );
});

// POST /api/places/:id/photos — upload foto galeri/menu dari halaman detail
// Terima multiple file sekaligus: field 'foto' maks 10 file
app.post('/api/places/:id/photos', upload.array('foto', 10), (req, res) => {
    const placeId = req.params.id;
    const { user_id, tipe, keterangan } = req.body;
    // tipe: 'menu' atau 'galeri'
    const jenisFoto = ['menu', 'galeri'].includes(tipe) ? tipe : 'galeri';

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'Tidak ada file yang diunggah.' });
    }

    const rows = req.files.map(file => [
        parseInt(placeId),
        parseInt(user_id) || null,
        jenisFoto,
        file.path, // file.path = Cloudinary URL
        keterangan || null
    ]);

    db.query(
        'INSERT INTO foto_tempat (tempat_makan_id, user_id, tipe, url, keterangan) VALUES ?',
        [rows],
        (err, result) => {
            if (err) {
                console.error('Gagal simpan foto:', err);
                return res.status(500).json({ success: false, message: 'Gagal menyimpan foto.' });
            }
            return res.status(201).json({
                success: true,
                message: `${req.files.length} foto berhasil diunggah!`,
                count: req.files.length
            });
        }
    );
});

// =========================================================================
// ULASAN / REVIEW
// =========================================================================

app.post('/api/reviews', (req, res) => {
    const { tempat_makan_id, user_id, rating, komentar, foto_ulasan } = req.body;
    db.query('INSERT INTO ulasan (tempat_makan_id, user_id, rating, komentar, foto_ulasan) VALUES (?, ?, ?, ?, ?)',
        [tempat_makan_id, user_id || 1, rating, komentar, foto_ulasan || null],
        (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Gagal mengirim ulasan.' });
            return res.status(201).json({ success: true, message: 'Ulasan berhasil diterbitkan!' });
        });
});

// =========================================================================
// ADMIN — MODERASI
// =========================================================================

app.get('/api/admin/places/pending', (req, res) => {
    db.query("SELECT * FROM tempat_makan WHERE status_verifikasi = 'Diproses' ORDER BY id DESC", (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil data' });
        if (!results.length) return res.json({ success: true, data: [] });

        let done = 0;
        const enriched = results.map(s => enrichSpot({ ...s, kategori_list: [] }));
        enriched.forEach((spot, i) => {
            getKategoriByPlaceId(spot.id, (err2, kategoris) => {
                enriched[i].kategori_list = kategoris;
                enriched[i].kategori = kategoris[0] || spot.kategori || '-';
                if (++done === enriched.length) res.json({ success: true, data: enriched });
            });
        });
    });
});

// GET /api/admin/places/all — semua tempat makan (untuk kelola koordinat)
app.get('/api/admin/places/all', (req, res) => {
    db.query(
        `SELECT tm.id, tm.nama, tm.alamat, tm.kategori, tm.university_id, tm.status_verifikasi,
                tm.harga_min, tm.harga_max, tm.deskripsi, tm.banner_img,
                tm.jam_buka, tm.jam_tutup,
                tm.latitude, tm.longitude,
                (tm.latitude != 0 OR tm.longitude != 0) AS has_coords,
                u.nama_universitas
         FROM tempat_makan tm
         LEFT JOIN universities u ON tm.university_id = u.id
         ORDER BY tm.id DESC`,
        (err, results) => {
            if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil data.' });
            const data = results.map(r => ({
                ...r,
                has_coords: !!(r.has_coords),
                latitude:  parseFloat(r.latitude)  || 0,
                longitude: parseFloat(r.longitude) || 0,
            }));
            return res.json({ success: true, data });
        }
    );
});

app.put('/api/admin/places/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    db.query('UPDATE tempat_makan SET status_verifikasi = ? WHERE id = ?', [status, id], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengubah status' });
        return res.json({ success: true, message: `Tempat makan berhasil ${status}!` });
    });
});

// ── PUT /api/admin/places/:id — Edit data tempat makan (override admin) ───────
app.put('/api/admin/places/:id', (req, res) => {
    const { id } = req.params;
    const { nama, alamat, kategori, harga_min, harga_max, deskripsi, jam_buka, jam_tutup, status_verifikasi } = req.body;

    if (!nama || !alamat) {
        return res.status(400).json({ success: false, message: 'Nama dan alamat wajib diisi.' });
    }

    const query = `
        UPDATE tempat_makan SET
            nama               = ?,
            alamat             = ?,
            kategori           = ?,
            harga_min          = ?,
            harga_max          = ?,
            deskripsi          = ?,
            jam_buka           = ?,
            jam_tutup          = ?,
            status_verifikasi  = ?
        WHERE id = ?
    `;
    const vals = [
        nama.trim(), alamat.trim(),
        kategori || 'Lainnya',
        parseInt(harga_min) || 0, parseInt(harga_max) || 0,
        deskripsi || '',
        jam_buka || '08:00', jam_tutup || '21:00',
        status_verifikasi || 'Disetujui',
        id
    ];

    db.query(query, vals, (err, result) => {
        if (err) { console.error('Edit tempat makan:', err); return res.status(500).json({ success: false, message: 'Gagal mengedit: ' + err.message }); }
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Tempat makan tidak ditemukan.' });
        return res.json({ success: true, message: 'Data tempat makan berhasil diperbarui!' });
    });
});

// ── DELETE /api/admin/places/:id — Hapus tempat makan permanen ────────────────
app.delete('/api/admin/places/:id', (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM tempat_makan WHERE id = ?', [id], (err, result) => {
        if (err) { console.error('Hapus tempat makan:', err); return res.status(500).json({ success: false, message: 'Gagal menghapus: ' + err.message }); }
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Tempat makan tidak ditemukan.' });
        return res.json({ success: true, message: 'Tempat makan berhasil dihapus permanen.' });
    });
});

app.get('/api/admin/reviews/pending', (req, res) => {
    db.query("SHOW COLUMNS FROM ulasan LIKE 'status_moderasi'", (err, cols) => {
        const q = (!err && cols.length > 0)
            ? `SELECT u.*, t.nama AS nama_warung FROM ulasan u JOIN tempat_makan t ON u.tempat_makan_id = t.id WHERE u.status_moderasi = 'Pending' ORDER BY u.id DESC`
            : `SELECT u.*, t.nama AS nama_warung FROM ulasan u JOIN tempat_makan t ON u.tempat_makan_id = t.id ORDER BY u.id DESC`;
        db.query(q, (err2, results) => {
            if (err2) return res.status(500).json({ success: false, message: 'Gagal mengambil ulasan' });
            return res.json({ success: true, data: results });
        });
    });
});

app.put('/api/admin/reviews/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    db.query("SHOW COLUMNS FROM ulasan LIKE 'status_moderasi'", (err, cols) => {
        if (!err && cols.length > 0) {
            db.query('UPDATE ulasan SET status_moderasi = ? WHERE id = ?', [status, id], (err2) => {
                if (err2) return res.status(500).json({ success: false, message: 'Gagal memoderasi ulasan' });
                return res.json({ success: true, message: `Ulasan berhasil ${status}!` });
            });
        } else {
            if (status === 'Ditolak') {
                db.query('DELETE FROM ulasan WHERE id = ?', [id], (err2) => {
                    if (err2) return res.status(500).json({ success: false, message: 'Gagal menghapus ulasan' });
                    return res.json({ success: true, message: 'Ulasan berhasil dihapus!' });
                });
            } else {
                return res.json({ success: true, message: 'Ulasan disetujui!' });
            }
        }
    });
});

// =========================================================================
// ADMIN — KELOLA KOTA
// =========================================================================

// GET semua kota (dengan jumlah kampus & tempat makan)
app.get('/api/admin/cities', (req, res) => {
    db.query(`
        SELECT c.*,
            (SELECT COUNT(*) FROM universities u WHERE u.city_id = c.id) AS jumlah_kampus,
            (SELECT COUNT(*) FROM universities u2
             JOIN tempat_makan tm ON tm.university_id = u2.id
             WHERE u2.city_id = c.id) AS jumlah_tempat_makan
        FROM cities c ORDER BY c.nama_kota ASC
    `, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil data kota' });
        return res.json({ success: true, data: results });
    });
});

// POST tambah kota baru
app.post('/api/admin/cities', (req, res) => {
    const { nama_kota } = req.body;
    if (!nama_kota || !nama_kota.trim()) return res.status(400).json({ success: false, message: 'Nama kota wajib diisi.' });
    db.query('INSERT INTO cities (nama_kota) VALUES (?)', [nama_kota.trim()], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: 'Nama kota sudah ada.' });
            return res.status(500).json({ success: false, message: 'Gagal menambah kota.' });
        }
        return res.status(201).json({ success: true, message: `Kota "${nama_kota.trim()}" berhasil ditambahkan!`, id: result.insertId });
    });
});

// PUT edit nama kota
app.put('/api/admin/cities/:id', (req, res) => {
    const { id } = req.params;
    const { nama_kota } = req.body;
    if (!nama_kota || !nama_kota.trim()) return res.status(400).json({ success: false, message: 'Nama kota wajib diisi.' });
    db.query('UPDATE cities SET nama_kota = ? WHERE id = ?', [nama_kota.trim(), id], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: 'Nama kota sudah ada.' });
            return res.status(500).json({ success: false, message: 'Gagal mengedit kota.' });
        }
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Kota tidak ditemukan.' });
        return res.json({ success: true, message: `Nama kota berhasil diubah menjadi "${nama_kota.trim()}".` });
    });
});

// DELETE hapus kota (cascade ke universities & tempat_makan)
app.delete('/api/admin/cities/:id', (req, res) => {
    const { id } = req.params;
    // Cek apakah ada kampus di kota ini dulu
    db.query('SELECT COUNT(*) AS cnt FROM universities WHERE city_id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error.' });
        if (rows[0].cnt > 0) {
            return res.status(400).json({ success: false, message: `Tidak bisa dihapus. Masih ada ${rows[0].cnt} kampus di kota ini. Hapus kampus terlebih dahulu.` });
        }
        db.query('DELETE FROM cities WHERE id = ?', [id], (err2) => {
            if (err2) return res.status(500).json({ success: false, message: 'Gagal menghapus kota.' });
            return res.json({ success: true, message: 'Kota berhasil dihapus.' });
        });
    });
});

// =========================================================================
// ADMIN — KELOLA KAMPUS / UNIVERSITAS
// =========================================================================

// GET semua kampus (dengan nama kota & jumlah tempat makan)
app.get('/api/admin/universities', (req, res) => {
    db.query(`
        SELECT u.*, c.nama_kota,
            (SELECT COUNT(*) FROM tempat_makan tm WHERE tm.university_id = u.id) AS jumlah_tempat_makan
        FROM universities u
        JOIN cities c ON u.city_id = c.id
        ORDER BY c.nama_kota ASC, u.nama_universitas ASC
    `, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil data kampus' });
        return res.json({ success: true, data: results });
    });
});

// POST tambah kampus baru
app.post('/api/admin/universities', (req, res) => {
    const { city_id, nama_universitas, latitude, longitude } = req.body;
    if (!city_id || !nama_universitas || !nama_universitas.trim()) {
        return res.status(400).json({ success: false, message: 'city_id dan nama_universitas wajib diisi.' });
    }
    const lat = parseFloat(latitude) || 0;
    const lng = parseFloat(longitude) || 0;
    db.query(
        'INSERT INTO universities (city_id, nama_universitas, latitude, longitude) VALUES (?, ?, ?, ?)',
        [parseInt(city_id), nama_universitas.trim(), lat, lng],
        (err, result) => {
            if (err) return res.status(500).json({ success: false, message: 'Gagal menambah kampus: ' + err.message });
            return res.status(201).json({ success: true, message: `Kampus "${nama_universitas.trim()}" berhasil ditambahkan!`, id: result.insertId });
        }
    );
});

// PUT edit kampus
app.put('/api/admin/universities/:id', (req, res) => {
    const { id } = req.params;
    const { city_id, nama_universitas, latitude, longitude } = req.body;
    if (!city_id || !nama_universitas || !nama_universitas.trim()) {
        return res.status(400).json({ success: false, message: 'city_id dan nama_universitas wajib diisi.' });
    }
    const lat = parseFloat(latitude) || 0;
    const lng = parseFloat(longitude) || 0;
    db.query(
        'UPDATE universities SET city_id = ?, nama_universitas = ?, latitude = ?, longitude = ? WHERE id = ?',
        [parseInt(city_id), nama_universitas.trim(), lat, lng, id],
        (err, result) => {
            if (err) return res.status(500).json({ success: false, message: 'Gagal mengedit kampus: ' + err.message });
            if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Kampus tidak ditemukan.' });
            return res.json({ success: true, message: `Kampus "${nama_universitas.trim()}" berhasil diperbarui!` });
        }
    );
});

// DELETE hapus kampus (cascade ke tempat_makan)
app.delete('/api/admin/universities/:id', (req, res) => {
    const { id } = req.params;
    db.query('SELECT COUNT(*) AS cnt FROM tempat_makan WHERE university_id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error.' });
        if (rows[0].cnt > 0) {
            return res.status(400).json({ success: false, message: `Tidak bisa dihapus. Masih ada ${rows[0].cnt} tempat makan terdaftar di kampus ini. Hapus tempat makan terlebih dahulu.` });
        }
        db.query('DELETE FROM universities WHERE id = ?', [id], (err2) => {
            if (err2) return res.status(500).json({ success: false, message: 'Gagal menghapus kampus.' });
            return res.json({ success: true, message: 'Kampus berhasil dihapus.' });
        });
    });
});


// =========================================================================
// ADMIN — KELOLA DATA USER / MAHASISWA
// =========================================================================

// GET semua user (tanpa password) + statistik kontribusi
app.get('/api/admin/users', (req, res) => {
    db.query(`
        SELECT
            u.id,
            u.nama_lengkap,
            u.email,
            u.nomor_telepon,
            u.role,
            u.foto_profil,
            COALESCE(u.status, 'Aktif') AS status,
            u.created_at,
            COUNT(DISTINCT tm.id)  AS jumlah_tempat_diajukan,
            COUNT(DISTINCT ul.id)  AS jumlah_ulasan
        FROM users u
        LEFT JOIN tempat_makan tm ON tm.user_id = u.id
        LEFT JOIN ulasan ul        ON ul.user_id  = u.id
        GROUP BY u.id
        ORDER BY u.created_at DESC
    `, (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil data user.' });
        return res.json({ success: true, data: results });
    });
});

// PUT blokir / aktifkan akun user
app.put('/api/admin/users/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // 'Aktif' | 'Diblokir'
    if (!['Aktif', 'Diblokir'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status tidak valid. Gunakan Aktif atau Diblokir.' });
    }
    // Lindungi akun Admin — tidak boleh diblokir
    db.query('SELECT role FROM users WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error.' });
        if (!rows.length) return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
        if (rows[0].role === 'Admin') return res.status(403).json({ success: false, message: 'Akun Admin tidak dapat diblokir.' });
        db.query('UPDATE users SET status = ? WHERE id = ?', [status, id], (err2) => {
            if (err2) return res.status(500).json({ success: false, message: 'Gagal mengubah status user.' });
            const msg = status === 'Diblokir'
                ? 'Akun berhasil diblokir. User tidak dapat login.'
                : 'Akun berhasil diaktifkan kembali.';
            return res.json({ success: true, message: msg });
        });
    });
});

// PUT reset kontribusi — semua tempat makan user dikembalikan ke status Diproses
app.put('/api/admin/users/:id/reset', (req, res) => {
    const { id } = req.params;
    db.query('SELECT role FROM users WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error.' });
        if (!rows.length) return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
        if (rows[0].role === 'Admin') return res.status(403).json({ success: false, message: 'Tidak dapat mereset akun Admin.' });
        db.query(
            "UPDATE tempat_makan SET status_verifikasi = 'Diproses' WHERE user_id = ? AND status_verifikasi = 'Disetujui'",
            [id],
            (err2, result) => {
                if (err2) return res.status(500).json({ success: false, message: 'Gagal mereset kontribusi.' });
                return res.json({ success: true, message: `${result.affectedRows} tempat makan dikembalikan ke status Diproses untuk direview ulang.` });
            }
        );
    });
});

// DELETE hapus akun user (cascade ke tempat_makan & ulasan)
app.delete('/api/admin/users/:id', (req, res) => {
    const { id } = req.params;
    db.query('SELECT role FROM users WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error.' });
        if (!rows.length) return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
        if (rows[0].role === 'Admin') return res.status(403).json({ success: false, message: 'Akun Admin tidak dapat dihapus dari panel ini.' });
        db.query('DELETE FROM users WHERE id = ?', [id], (err2) => {
            if (err2) return res.status(500).json({ success: false, message: 'Gagal menghapus akun user.' });
            return res.json({ success: true, message: 'Akun user dan seluruh data terkait berhasil dihapus.' });
        });
    });
});


// =========================================================================
// ADMIN — STATISTIK & OVERVIEW DASHBOARD
// =========================================================================

app.get('/api/admin/stats', (req, res) => {
    const results = {};
    let pending = 6;

    const done = () => {
        if (--pending === 0) return res.json({ success: true, data: results });
    };

    // 1. Ringkasan utama: total tempat makan per status + total ulasan + total user aktif
    db.query(`
        SELECT
            SUM(CASE WHEN status_verifikasi = 'Disetujui' THEN 1 ELSE 0 END) AS terverifikasi,
            SUM(CASE WHEN status_verifikasi = 'Diproses'  THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status_verifikasi = 'Ditolak'   THEN 1 ELSE 0 END) AS ditolak,
            COUNT(*) AS total_tempat_makan
        FROM tempat_makan
    `, (err, rows) => {
        results.tempat_makan = err ? {} : rows[0];
        done();
    });

    // 2. Total ulasan + rata-rata rating
    db.query(`SELECT COUNT(*) AS total, AVG(rating) AS rata_rata FROM ulasan`, (err, rows) => {
        results.ulasan = err ? {} : {
            total:     rows[0].total || 0,
            rata_rata: rows[0].rata_rata ? parseFloat(rows[0].rata_rata).toFixed(1) : '0.0',
        };
        done();
    });

    // 3. Total user aktif vs diblokir (exclude admin)
    db.query(`
        SELECT
            SUM(CASE WHEN status = 'Aktif'    THEN 1 ELSE 0 END) AS aktif,
            SUM(CASE WHEN status = 'Diblokir' THEN 1 ELSE 0 END) AS diblokir,
            COUNT(*) AS total
        FROM users WHERE role = 'Mahasiswa'
    `, (err, rows) => {
        results.users = err ? {} : rows[0];
        done();
    });

    // 4. Top 5 kota paling aktif (berdasarkan jumlah tempat makan disetujui)
    db.query(`
        SELECT c.nama_kota,
            COUNT(tm.id) AS jumlah_tempat,
            (SELECT COUNT(*) FROM universities u2 WHERE u2.city_id = c.id) AS jumlah_kampus,
            (SELECT COUNT(*) FROM ulasan ul
             JOIN tempat_makan tm2 ON ul.tempat_makan_id = tm2.id
             JOIN universities  u3 ON tm2.university_id = u3.id
             WHERE u3.city_id = c.id) AS jumlah_ulasan
        FROM cities c
        LEFT JOIN universities u ON u.city_id = c.id
        LEFT JOIN tempat_makan tm ON tm.university_id = u.id AND tm.status_verifikasi = 'Disetujui'
        GROUP BY c.id, c.nama_kota
        ORDER BY jumlah_tempat DESC
        LIMIT 5
    `, (err, rows) => {
        results.top_kota = err ? [] : rows;
        done();
    });

    // 5. Top 5 universitas paling aktif
    db.query(`
        SELECT u.nama_universitas, c.nama_kota,
            COUNT(tm.id) AS jumlah_tempat,
            (SELECT COUNT(*) FROM ulasan ul
             JOIN tempat_makan tm2 ON ul.tempat_makan_id = tm2.id
             WHERE tm2.university_id = u.id) AS jumlah_ulasan
        FROM universities u
        JOIN cities c ON u.city_id = c.id
        LEFT JOIN tempat_makan tm ON tm.university_id = u.id AND tm.status_verifikasi = 'Disetujui'
        GROUP BY u.id, u.nama_universitas, c.nama_kota
        ORDER BY jumlah_tempat DESC
        LIMIT 5
    `, (err, rows) => {
        results.top_universitas = err ? [] : rows;
        done();
    });

    // 6. Aktivitas 7 hari terakhir: tempat makan baru + ulasan baru
    db.query(`
        SELECT
            (SELECT COUNT(*) FROM tempat_makan WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS tempat_baru,
            (SELECT COUNT(*) FROM ulasan      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS ulasan_baru,
            (SELECT COUNT(*) FROM users       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND role = 'Mahasiswa') AS user_baru,
            (SELECT COUNT(*) FROM foto_tempat WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS foto_baru
    `, (err, rows) => {
        results.aktivitas_minggu = err ? {} : rows[0];
        done();
    });
});



// GET /api/users/:id/reviews — semua ulasan yang ditulis user
app.get('/api/users/:id/reviews', (req, res) => {
    const { id } = req.params;
    db.query(`
        SELECT
            ul.id, ul.rating, ul.komentar, ul.foto_ulasan,
            COALESCE(ul.status_moderasi, 'Pending') AS status_moderasi,
            ul.created_at,
            ul.tempat_makan_id,
            tm.nama AS nama_tempat
        FROM ulasan ul
        JOIN tempat_makan tm ON tm.id = ul.tempat_makan_id
        WHERE ul.user_id = ?
        ORDER BY ul.created_at DESC
    `, [id], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil ulasan.' });
        return res.json({ success: true, data: results });
    });
});

// =========================================================================
// FAVORIT TEMPAT MAKAN
// =========================================================================

// GET cek status favorit satu tempat makan untuk user tertentu
app.get('/api/favorites/check', (req, res) => {
    const { user_id, tempat_makan_id } = req.query;
    if (!user_id || !tempat_makan_id) return res.status(400).json({ success: false, message: 'user_id dan tempat_makan_id wajib.' });
    db.query(
        'SELECT id FROM favorit_tempat WHERE user_id = ? AND tempat_makan_id = ?',
        [user_id, tempat_makan_id],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: 'Server error.' });
            return res.json({ success: true, is_favorit: rows.length > 0 });
        }
    );
});

// POST tambah favorit (toggle: tambah jika belum ada, hapus jika sudah)
app.post('/api/favorites/toggle', (req, res) => {
    const user_id         = parseInt(req.body.user_id);
    const tempat_makan_id = parseInt(req.body.tempat_makan_id);

    if (!user_id        || isNaN(user_id))         return res.status(400).json({ success: false, message: 'user_id tidak valid.' });
    if (!tempat_makan_id || isNaN(tempat_makan_id)) return res.status(400).json({ success: false, message: 'tempat_makan_id tidak valid.' });

    // Pastikan tempat makan ada di database (tidak perlu harus Disetujui, user boleh favorit kapan saja)
    db.query('SELECT id FROM tempat_makan WHERE id = ?', [tempat_makan_id], (errCheck, checkRows) => {
        if (errCheck) { console.error('Toggle fav check:', errCheck); return res.status(500).json({ success: false, message: 'Server error.' }); }
        if (!checkRows.length) return res.status(404).json({ success: false, message: 'Tempat makan tidak ditemukan.' });

        db.query(
            'SELECT id FROM favorit_tempat WHERE user_id = ? AND tempat_makan_id = ?',
            [user_id, tempat_makan_id],
            (err, rows) => {
                if (err) { console.error('Toggle fav select:', err); return res.status(500).json({ success: false, message: 'Server error.' }); }
                if (rows.length > 0) {
                    // Sudah favorit → hapus
                    db.query('DELETE FROM favorit_tempat WHERE user_id = ? AND tempat_makan_id = ?', [user_id, tempat_makan_id], (err2) => {
                        if (err2) { console.error('Toggle fav delete:', err2); return res.status(500).json({ success: false, message: 'Gagal menghapus favorit.' }); }
                        return res.json({ success: true, is_favorit: false, message: 'Dihapus dari favorit.' });
                    });
                } else {
                    // Belum favorit → tambah
                    db.query('INSERT INTO favorit_tempat (user_id, tempat_makan_id) VALUES (?, ?)', [user_id, tempat_makan_id], (err2) => {
                        if (err2) { console.error('Toggle fav insert:', err2); return res.status(500).json({ success: false, message: 'Gagal menambah favorit.' }); }
                        return res.json({ success: true, is_favorit: true, message: 'Ditambahkan ke favorit! ❤️' });
                    });
                }
            }
        );
    });
});

// GET semua favorit user (dengan detail lengkap tempat makan)
app.get('/api/favorites', (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ success: false, message: 'user_id wajib.' });
    db.query(`
        SELECT
            tm.id, tm.nama, tm.alamat, tm.kategori, tm.harga_min, tm.harga_max,
            tm.banner_img, tm.jam_buka, tm.jam_tutup,
            tm.latitude, tm.longitude, tm.status_verifikasi,
            f.created_at AS favorit_at,
            COALESCE(
                (SELECT AVG(u2.rating) FROM ulasan u2 WHERE u2.tempat_makan_id = tm.id AND u2.status_moderasi = 'Disetujui'),
                0
            ) AS rating,
            COALESCE(
                (SELECT COUNT(*) FROM ulasan u3 WHERE u3.tempat_makan_id = tm.id AND u3.status_moderasi = 'Disetujui'),
                0
            ) AS jumlah_ulasan
        FROM favorit_tempat f
        JOIN tempat_makan tm ON tm.id = f.tempat_makan_id
        WHERE f.user_id = ?
          AND tm.status_verifikasi = 'Disetujui'
        ORDER BY f.created_at DESC
    `, [user_id], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal mengambil favorit.' });
        return res.json({ success: true, data: results });
    });
});

app.listen(PORT, () => console.log(`\nServer Univora berjalan di http://localhost:${PORT}\n`));
