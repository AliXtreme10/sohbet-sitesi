// server.js
require('dotenv').config(); // .env dosyasındaki değişkenleri process.env'e yükler
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);

// --- AYARLAR ---
// JWT_SECRET artık .env dosyasından okunur. .env yoksa geçici bir anahtar kullanılır ve uyarı verilir.
const JWT_SECRET = process.env.JWT_SECRET || 'cok-gizli-anahtar-bunu-degistir';
if (!process.env.JWT_SECRET) {
    console.warn('UYARI: JWT_SECRET .env dosyasında bulunamadı. Geçici/güvensiz bir anahtar kullanılıyor. Lütfen .env dosyası oluşturun.');
}
const TOKEN_EXPIRES = '7d';
const SALT_ROUNDS = 10;

// --- CORS VE SOCKET.IO YAPILANDIRMASI ---
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:3000", "http://localhost:8080", "http://127.0.0.1:3000"],
        methods: ["GET", "POST"],
        credentials: true
    }
});

// --- MIDDLEWARES ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- MULTER DOSYA YÜKLEME YAPILANDIRMASI ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, './uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- VERİTABANI (SQLite - KALICI) ---
const db = new sqlite3.Database(path.join(__dirname, 'database.db'), (err) => {
    if (err) {
        console.error('Veritabanına bağlanılamadı:', err.message);
    } else {
        console.log('database.db veritabanına bağlanıldı.');
    }
});

// sqlite3 callback API'sini Promise'e çeviren yardımcılar
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err); else resolve(this); // this.lastID, this.changes
    });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
});

// --- TABLOLARI OLUŞTUR ---
async function initDb() {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            nickname TEXT,
            password_hash TEXT NOT NULL,
            profile_pic TEXT DEFAULT '',
            description TEXT DEFAULT ''
        )
    `);
    await dbRun(`
        CREATE TABLE IF NOT EXISTS friend_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            requester_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(requester_id, receiver_id)
        )
    `);
    await dbRun(`
        CREATE TABLE IF NOT EXISTS friendships (
            user_id1 INTEGER,
            user_id2 INTEGER,
            status TEXT CHECK(status IN('pending', 'accepted')) NOT NULL,
            PRIMARY KEY (user_id1, user_id2),
            FOREIGN KEY (user_id1) REFERENCES users(id),
            FOREIGN KEY (user_id2) REFERENCES users(id)
        )
    `);
    await dbRun(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER,
            receiver_id INTEGER,
            content TEXT NOT NULL,
            type TEXT DEFAULT 'text',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sender_id) REFERENCES users(id),
            FOREIGN KEY (receiver_id) REFERENCES users(id)
        )
    `);

    // Eski DB'lerle uyumluluk: messages tablosunda is_read kolonu yoksa ekle
    const messageCols = await dbAll("PRAGMA table_info(messages)");
    if (!messageCols.some(c => c.name === 'is_read')) {
        await dbRun("ALTER TABLE messages ADD COLUMN is_read INTEGER DEFAULT 0");
    }

    console.log('Tablolar hazır.');
}

let activeSockets = {}; // userId -> socket.id eşleşmesi (runtime durumu)

// --- YARDIMCI FONKSİYONLAR ---
function publicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        nickname: user.nickname || user.username,
        profile_pic: user.profile_pic || '',
        description: user.description || ''
    };
}

async function getUserById(id) {
    return dbGet('SELECT * FROM users WHERE id = ?', [id]);
}

async function getUserByUsername(username) {
    const clean = (username || '').trim();
    if (!clean) return null;
    return dbGet('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [clean]);
}

// Arkadaşlık çiftini her zaman aynı sırada (küçük, büyük) tutarız ki çift kayıt olmasın
function orderedPair(a, b) {
    return a < b ? [a, b] : [b, a];
}

async function getFriendList(userId) {
    const rows = await dbAll(`
        SELECT u.* FROM friendships f
        JOIN users u ON u.id = (CASE WHEN f.user_id1 = ? THEN f.user_id2 ELSE f.user_id1 END)
        WHERE (f.user_id1 = ? OR f.user_id2 = ?) AND f.status = 'accepted'
    `, [userId, userId, userId]);
    return rows.map(u => ({
        ...publicUser(u),
        isOnline: !!activeSockets[u.id]
    }));
}

async function getPendingRequests(userId) {
    const rows = await dbAll(`
        SELECT u.* FROM friend_requests r
        JOIN users u ON u.id = r.requester_id
        WHERE r.receiver_id = ?
        ORDER BY r.created_at DESC
    `, [userId]);
    return rows.map(publicUser);
}

async function areFriends(a, b) {
    const [x, y] = orderedPair(a, b);
    const row = await dbGet(
        "SELECT 1 FROM friendships WHERE user_id1 = ? AND user_id2 = ? AND status = 'accepted'",
        [x, y]
    );
    return !!row;
}

async function makeFriends(a, b) {
    const [x, y] = orderedPair(a, b);
    await dbRun(
        "INSERT OR REPLACE INTO friendships (user_id1, user_id2, status) VALUES (?, ?, 'accepted')",
        [x, y]
    );
}

// readerId, senderId'den gelen okunmamış mesajları "okundu" yapar ve göndereni bilgilendirir
async function markMessagesRead(senderId, readerId) {
    const result = await dbRun(
        'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
        [senderId, readerId]
    );
    if (result.changes > 0) {
        const senderSocketId = activeSockets[senderId];
        if (senderSocketId) {
            io.to(senderSocketId).emit('messages_read', { byUserId: readerId });
        }
    }
}

// Bearer token'dan kullanıcı id'sini çöz (HTTP istekleri için)
function getUserIdFromAuthHeader(req) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded.id;
    } catch (err) {
        return null;
    }
}

// --- HTTP ENDPOINT'LERİ (API CALLS) ---

// Token Doğrulama API'si
app.post('/verify-token', (req, res) => {
    const userId = getUserIdFromAuthHeader(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Token geçersiz veya süresi dolmuş.' });
    return res.json({ success: true, message: 'Token geçerli.' });
});

// Kayıt Olma API'si
app.post('/register', async (req, res) => {
    try {
        const { username, nickname, password } = req.body;
        if (!username || !password) {
            return res.json({ success: false, message: 'Kullanıcı adı ve şifre zorunludur.' });
        }
        const existing = await getUserByUsername(username);
        if (existing) {
            return res.json({ success: false, message: 'Bu kullanıcı adı zaten alınmış.' });
        }
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        await dbRun(
            'INSERT INTO users (username, nickname, password_hash) VALUES (?, ?, ?)',
            [username.trim(), (nickname || username).trim(), hash]
        );
        res.json({ success: true, message: 'Kayıt başarıyla tamamlandı. Giriş yapabilirsiniz.' });
    } catch (error) {
        console.error('register hatası:', error);
        res.json({ success: false, message: 'Kayıt sırasında bir hata oluştu.' });
    }
});

// Giriş Yapma API'si
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await getUserByUsername(username);
        if (!user) {
            return res.json({ success: false, message: 'Kullanıcı adı veya şifre hatalı.' });
        }
        const ok = await bcrypt.compare(password || '', user.password_hash);
        if (!ok) {
            return res.json({ success: false, message: 'Kullanıcı adı veya şifre hatalı.' });
        }
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRES });
        res.json({
            success: true,
            token,
            user: publicUser(user)
        });
    } catch (error) {
        console.error('login hatası:', error);
        res.json({ success: false, message: 'Giriş sırasında bir hata oluştu.' });
    }
});

// Sohbet İçi Dosya Yükleme API'si
app.post('/upload-chat-file', upload.single('chatFile'), (req, res) => {
    if (!req.file) return res.json({ success: false, message: 'Dosya yüklenemedi.' });
    res.json({ success: true, filePath: `/uploads/${req.file.filename}` });
});

// Profil Fotoğrafı Yükleme API'si (DB'ye de kaydeder)
app.post('/upload-profile-pic', upload.single('profilePic'), async (req, res) => {
    try {
        if (!req.file) return res.json({ success: false, message: 'Fotoğraf yüklenemedi.' });
        const userId = getUserIdFromAuthHeader(req);
        const filePath = `/uploads/${req.file.filename}`;
        if (userId) {
            await dbRun('UPDATE users SET profile_pic = ? WHERE id = ?', [filePath, userId]);
        }
        res.json({ success: true, profilePic: filePath });
    } catch (error) {
        console.error('upload-profile-pic hatası:', error);
        res.json({ success: false, message: 'Fotoğraf kaydedilemedi.' });
    }
});


// --- SOCKET.IO EVENT LISTENERS ---
io.on('connection', (socket) => {
    let authenticatedUserId = null;

    console.log(`Yeni bir soket bağlantısı kuruldu: ${socket.id}`);

    // 1. Kimlik Doğrulama Mekanizması (JWT)
    socket.on('authenticate', async (data) => {
        try {
            const decoded = jwt.verify(data.token, JWT_SECRET);
            authenticatedUserId = decoded.id;

            const user = await getUserById(authenticatedUserId);
            if (!user) {
                return socket.emit('error', 'Kullanıcı bulunamadı.');
            }

            activeSockets[authenticatedUserId] = socket.id;
            socket.userId = authenticatedUserId;

            socket.emit('authenticated');

            // Arkadaşlarına çevrimiçi bilgisini gönder
            io.emit('friend_status_change', { userId: authenticatedUserId, isOnline: true });
            console.log(`Soket ${socket.id} başarıyla userId: ${authenticatedUserId} olarak doğrulandı.`);
        } catch (err) {
            socket.emit('error', 'Kimlik doğrulaması başarısız oldu.');
        }
    });

    // 2. Arkadaş Listesini Yükleme
    socket.on('load_friend_list', async () => {
        if (!socket.userId) return;
        try {
            socket.emit('load_friend_list', await getFriendList(socket.userId));
        } catch (error) {
            console.error('load_friend_list hatası:', error);
            socket.emit('error', 'Arkadaş listesi yüklenemedi.');
        }
    });

    // 3. Bekleyen İstekleri İlk Girişte Yükleme
    socket.on('load_pending_requests', async () => {
        if (!socket.userId) return;
        try {
            socket.emit('load_pending_requests', await getPendingRequests(socket.userId));
        } catch (error) {
            console.error("Bekleyen istekler yüklenirken hata:", error);
            socket.emit('error', 'Bekleyen istekler yüklenemedi.');
        }
    });

    // 4. Arkadaş Ekleme İsteği Gönderme
    socket.on('add_friend', async (friendUsername) => {
        if (!socket.userId) return;
        try {
            const cleanUsername = (friendUsername || '').trim();
            if (!cleanUsername) {
                return socket.emit('error', 'Kullanıcı adı boş olamaz.');
            }

            // Hedef kullanıcıyı GERÇEKTEN username'e göre bul
            const targetUser = await getUserByUsername(cleanUsername);
            if (!targetUser) {
                return socket.emit('error', 'Böyle bir kullanıcı bulunamadı.');
            }
            const targetUserId = targetUser.id;

            if (targetUserId === socket.userId) {
                return socket.emit('error', 'Kendinize arkadaşlık isteği gönderemezsiniz.');
            }

            if (await areFriends(socket.userId, targetUserId)) {
                return socket.emit('error', 'Bu kullanıcı zaten arkadaşınız.');
            }

            // Karşı taraf bana zaten istek gönderdiyse, otomatik kabul et
            const reverse = await dbGet(
                'SELECT 1 FROM friend_requests WHERE requester_id = ? AND receiver_id = ?',
                [targetUserId, socket.userId]
            );
            if (reverse) {
                await dbRun('DELETE FROM friend_requests WHERE requester_id = ? AND receiver_id = ?', [targetUserId, socket.userId]);
                await makeFriends(socket.userId, targetUserId);

                socket.emit('load_friend_list', await getFriendList(socket.userId));
                const tSock = activeSockets[targetUserId];
                if (tSock) io.to(tSock).emit('load_friend_list', await getFriendList(targetUserId));
                return socket.emit('profile_updated', { type: 'friend_request', value: 'Karşılıklı istek, arkadaş oldunuz.' });
            }

            // İsteği kaydet (varsa tekrar etmesin)
            const result = await dbRun(
                'INSERT OR IGNORE INTO friend_requests (requester_id, receiver_id) VALUES (?, ?)',
                [socket.userId, targetUserId]
            );
            if (result.changes === 0) {
                return socket.emit('error', 'Bu kullanıcıya zaten istek gönderdiniz.');
            }

            // Gönderenin gerçek bilgisi
            const requester = await getUserById(socket.userId);
            const requesterInfo = publicUser(requester);

            // Hedef çevrimiçiyse anlık bildir
            const targetSocketId = activeSockets[targetUserId];
            if (targetSocketId) {
                io.to(targetSocketId).emit('friend_request_received', requesterInfo);
            }

            socket.emit('profile_updated', { type: 'friend_request', value: 'İstek gönderildi.' });
        } catch (error) {
            console.error('add_friend hatası:', error);
            socket.emit('error', 'Arkadaş eklenirken hata oluştu.');
        }
    });

    // 5. Arkadaşlık İsteğine Yanıt Verme (Kabul/Red)
    socket.on('respond_to_friend_request', async ({ requesterId, accept }) => {
        if (!socket.userId) return;
        try {
            // İsteği temizle
            await dbRun(
                'DELETE FROM friend_requests WHERE requester_id = ? AND receiver_id = ?',
                [requesterId, socket.userId]
            );

            if (accept) {
                await makeFriends(socket.userId, requesterId);
                console.log(`${socket.userId} ve ${requesterId} artık arkadaş.`);

                // Her iki tarafa da güncel arkadaş listesini push et
                socket.emit('load_friend_list', await getFriendList(socket.userId));
                const requesterSocketId = activeSockets[requesterId];
                if (requesterSocketId) {
                    io.to(requesterSocketId).emit('load_friend_list', await getFriendList(requesterId));
                }
            }
        } catch (error) {
            console.error('respond_to_friend_request hatası:', error);
            socket.emit('error', 'İstek yanıtlanırken bir hata oluştu.');
        }
    });

    // 6. Mesaj Geçmişini İsteme (KALICI)
    socket.on('request_chat_history', async ({ friendId }) => {
        if (!socket.userId) return;
        try {
            const rows = await dbAll(`
                SELECT * FROM messages
                WHERE (sender_id = ? AND receiver_id = ?)
                   OR (sender_id = ? AND receiver_id = ?)
                ORDER BY timestamp ASC, id ASC
            `, [socket.userId, friendId, friendId, socket.userId]);

            const history = rows.map(m => ({
                id: m.id,
                senderId: m.sender_id,
                receiverId: m.receiver_id,
                content: m.content,
                type: m.type,
                timestamp: m.timestamp,
                isRead: !!m.is_read
            }));
            socket.emit('chat_history', history);

            // Sohbeti açan kişi karşıdan gelen okunmamış mesajları okumuş sayılır
            await markMessagesRead(friendId, socket.userId);
        } catch (error) {
            console.error('request_chat_history hatası:', error);
            socket.emit('error', 'Sohbet geçmişi yüklenemedi.');
        }
    });

    // Mesajları "okundu" olarak işaretle (sohbet açıkken yeni mesaj gelince çağrılır)
    socket.on('mark_read', async ({ friendId }) => {
        if (!socket.userId) return;
        try {
            await markMessagesRead(friendId, socket.userId);
        } catch (error) {
            console.error('mark_read hatası:', error);
        }
    });

    // Mesaj Gönderme (KALICI)
    socket.on('send_message', async (data) => {
        if (!socket.userId) return;
        try {
            // Önce veritabanına kaydet
            const result = await dbRun(
                'INSERT INTO messages (sender_id, receiver_id, content, type) VALUES (?, ?, ?, ?)',
                [socket.userId, data.receiverId, data.content, data.type || 'text']
            );

            const receiverSocketId = activeSockets[data.receiverId];
            const delivered = !!receiverSocketId; // alıcı çevrimiçiyse iletildi sayılır

            const messagePayload = {
                id: result.lastID,
                senderId: socket.userId,
                receiverId: data.receiverId,
                content: data.content,
                type: data.type || 'text',
                timestamp: new Date(),
                delivered: delivered,
                isRead: false
            };

            // Kendisine gönder (gönderildi/iletildi tiki için)
            socket.emit('new_message', messagePayload);

            // Alıcı çevrimiçiyse ona gönder
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('new_message', messagePayload);
            }
        } catch (error) {
            console.error('send_message hatası:', error);
            socket.emit('error', 'Mesaj gönderilemedi.');
        }
    });

    // 7. Yazıyor Göstergeleri
    socket.on('typing_start', ({ receiverId }) => {
        const receiverSocketId = activeSockets[receiverId];
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('display_typing', { senderId: socket.userId, isTyping: true });
        }
    });

    socket.on('typing_stop', ({ receiverId }) => {
        const receiverSocketId = activeSockets[receiverId];
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('display_typing', { senderId: socket.userId, isTyping: false });
        }
    });

    // 8. Profil Güncelleme (KALICI)
    socket.on('update_profile', async (data) => {
        if (!socket.userId) return;
        try {
            if (data.type === 'nickname') {
                await dbRun('UPDATE users SET nickname = ? WHERE id = ?', [data.value, socket.userId]);
                return socket.emit('profile_updated', { type: 'nickname', value: data.value });
            }
            if (data.type === 'description') {
                await dbRun('UPDATE users SET description = ? WHERE id = ?', [data.value, socket.userId]);
                return socket.emit('profile_updated', { type: 'description', value: data.value });
            }
            if (data.type === 'password') {
                const { oldPassword, newPassword } = data.value || {};
                const user = await getUserById(socket.userId);
                const ok = await bcrypt.compare(oldPassword || '', user.password_hash);
                if (!ok) {
                    return socket.emit('error', 'Mevcut şifre hatalı.');
                }
                const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
                await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hash, socket.userId]);
                return socket.emit('profile_updated', { type: 'password', value: 'Güncellendi' });
            }
        } catch (error) {
            console.error('update_profile hatası:', error);
            socket.emit('error', 'Profil güncellenemedi.');
        }
    });

    // 9. WebRTC Video Arama Sinyalleri
    socket.on('call-user', ({ offer, to }) => {
        const targetSocketId = activeSockets[to];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call-offer', { offer, from: socket.userId });
        } else {
            socket.emit('call-failed', 'Kullanıcı çevrimdışı.');
        }
    });

    socket.on('call-answer', ({ answer, to }) => {
        const targetSocketId = activeSockets[to];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call-answer', { answer });
        }
    });

    socket.on('ice-candidate', ({ candidate, to }) => {
        const targetSocketId = activeSockets[to];
        if (targetSocketId) {
            io.to(targetSocketId).emit('ice-candidate', { candidate });
        }
    });

    socket.on('end-call', ({ to }) => {
        const targetSocketId = activeSockets[to];
        if (targetSocketId) {
            io.to(targetSocketId).emit('end-call');
        }
    });

    // 10. Bağlantı Koptuğunda
    socket.on('disconnect', () => {
        if (authenticatedUserId) {
            delete activeSockets[authenticatedUserId];
            io.emit('friend_status_change', { userId: authenticatedUserId, isOnline: false });
            console.log(`Kullanıcı ayrıldı: ${authenticatedUserId} (Soket: ${socket.id})`);
        }
    });
});

// --- SUNUCUYU BAŞLATMA ---
const PORT = process.env.PORT || 8080;
initDb()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`==================================================`);
            console.log(` Sunucu ${PORT} portunda başarıyla başlatıldı.`);
            console.log(` Adres: http://localhost:${PORT}`);
            console.log(`==================================================`);
        });
    })
    .catch((err) => {
        console.error('Veritabanı başlatılamadı, sunucu kapanıyor:', err);
        process.exit(1);
    });
