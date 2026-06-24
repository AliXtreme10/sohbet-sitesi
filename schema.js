// schema.js - mevcut database.db şemasını yazdırır
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(path.join(__dirname, 'database.db'));

db.all("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name", [], (err, rows) => {
    if (err) { console.error('Hata:', err.message); process.exit(1); }
    if (!rows.length) { console.log('Hic tablo yok.'); process.exit(0); }
    rows.forEach(r => {
        console.log('================================================');
        console.log('TABLO:', r.name);
        console.log(r.sql);
        console.log('');
    });
    process.exit(0);
});
