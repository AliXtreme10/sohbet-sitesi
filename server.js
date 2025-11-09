// server.js

// --- GEREKLİ PAKETLERİN YÜKLENMESİ ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const jwt = require('jsonwebtoken'); // JWT için
const { expressjwt } = require('express-jwt'); // JWT doğrulama için

// --- SUNUCU VE UYGULAMA KURULUMU ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- MIDDLEWARE (ARAYAZILIM) AYARLARI ---
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- MULTTER (DOSYA YÜKLEME) AYARLARI ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/'); },
    filename: function (req, file, cb) { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

// --- JWT AYARLARI ---
const JWT_SECRET = process.env.JWT_SECRET || 'gizli-bir-sifre'; // Gerçek bir projede environment variable kullanın
const JWT_EXPIRES_IN = '7d'; // Tokenın geçerlilik süresi

// JWT doğrulama middleware'i
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Erişim anahtarı gerekli.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Geçersiz token.' });
        }
        req.user = user; // Kullanıcı bilgisini request'e ekle
        next();
    });
};

// --- VERİTABANI BAĞLANTISI VE KURULUMU ---
const db = new sqlite3.Database('./database.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) { console.error("Veritabanına bağlanırken hata oluştu:", err.message); } else {
        console.log('SQLite veritabanına başarıyla bağlanıldı.');
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            nickname TEXT,
            profile_pic TEXT DEFAULT 'default.png',
            description TEXT DEFAULT ''
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS friendships (
            user_id1 INTEGER,
            user_id2 INTEGER,
            status TEXT CHECK(status IN('pending', 'accepted')) NOT NULL,
            PRIMARY KEY (user_id1, user_id2),
            FOREIGN KEY (user_id1) REFERENCES users(id),
            FOREIGN KEY (user_id2) REFERENCES users(id)
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER,
            receiver_id INTEGER,
            content TEXT NOT NULL,
            type TEXT DEFAULT 'text',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sender_id) REFERENCES users(id),
            FOREIGN KEY (receiver_id) REFERENCES users(id)
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS status_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            content TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);
    });
}

// --- API ROTALARI ---

// Kayıt Olma Rotası
app.post('/register', async (req, res) => {
    const { username, password, nickname } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Kullanıcı adı ve şifre zorunludur.' });
    }
    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const sql = 'INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)';
        db.run(sql, [username, passwordHash, nickname || username], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ success: false, message: 'Uyarı: Bu kullanıcı adı önceden kullanılmış.' });
                }
                return res.status(500).json({ success: false, message: 'Veritabanı hatası.' });
            }
            res.json({ success: true, message: 'Kayıt başarılı! Giriş yapabilirsiniz.' });
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Sunucu hatası.' });
    }
});

// Giriş Yapma Rotası (JWT oluşturur)
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const sql = 'SELECT * FROM users WHERE username = ?';
    db.get(sql, [username], async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı.' });
        }
        const match = await bcrypt.compare(password, user.password_hash);
        if (match) {
            const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
            res.json({ success: true, token: token, user: { id: user.id, username: user.username, nickname: user.nickname, profile_pic: user.profile_pic } });
        } else {
            res.status(401).json({ success: false, message: 'Kullanıcı adı veya şifre hatalı.' });
        }
    });
});

// Token Yenileme Rotası
app.post('/refresh-token', authenticateToken, (req, res) => {
    const token = jwt.sign({ id: req.user.id, username: req.user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ success: true, token: token });
});

// Profil Fotoğrafı Yükleme Rotası
app.post('/upload-profile-pic', upload.single('profilePic'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Dosya yüklenmedi.' });
    }
    const userId = req.user.id; // authenticateToken sayesinde req.user artık mevcut
    const filePath = `/uploads/${req.file.filename}`;
    const sql = 'UPDATE users SET profile_pic = ? WHERE id = ?';
    db.run(sql, [filePath, userId], (err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Veritabanı güncellenemedi.' });
        }
        res.json({ success: true, profilePic: filePath });
    });
});

// Sohbet Dosyası Yükleme Rotası
app.post('/upload-chat-file', upload.single('chatFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Dosya seçilmedi.' });
    }
    const filePath = `/uploads/${req.file.filename}`;
    res.json({ success: true, filePath: filePath });
});


// --- SOCKET.IO GERÇEK ZAMANLI MANTIĞI ---

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication error'));
    }
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error('Authentication error'));
        socket.userId = decoded.id;
        socket.username = decoded.username;
        next();
    });
});

const connectedUsers = {}; // { userId: socketId }

io.on('connection', (socket) => {
    console.log(`[DEBUG] ${socket.username} (${socket.userId}) bağlandı.`);

    socket.on('disconnect', () => {
        console.log(`[DEBUG] ${socket.username} (${socket.userId}) ayrıldı.`);
        delete connectedUsers[socket.userId];
    });

    // Arkadaş Ekleme İsteği
    socket.on('add_friend', (friendUsername) => {
        console.log(`[DEBUG] ${socket.username} kullanıcısı, '${friendUsername}' kullanıcısına arkadaşlık isteği gönderiyor.`);
        const sql = 'SELECT id FROM users WHERE username = ?';
        db.get(sql, [friendUsername], (err, friend) => {
            if (err || !friend) {
                socket.emit('error', 'Böyle bir kullanıcı bulunamadı.');
                return;
            }
            if (friend.id === socket.userId) {
                socket.emit('error', 'Kendinize arkadaş isteği gönderemezsiniz.');
                return;
            }
            const checkSql = 'SELECT * FROM friendships WHERE (user_id1 = ? AND user_id2 = ?) OR (user_id1 = ? AND user_id2 = ?)';
            db.get(checkSql, [socket.userId, friend.id, friend.id, socket.userId], (err, row) => {
                if (row) {
                    socket.emit('error', 'Bu kullanıcıyla zaten arkadaşsınız veya istek gönderilmiş.');
                    return;
                }
                const insertSql = 'INSERT INTO friendships (user_id1, user_id2, status) VALUES (?, ?, ?)';
                db.run(insertSql, [socket.userId, friend.id, 'pending'], (err) => {
                    if (err) return;
                    console.log(`[DEBUG] İstek veritabanına kaydedildi. Şimdi bildirim gönderilecek.`);
                    const targetSocketId = connectedUsers[friend.id];
                    if (targetSocketId) {
                        getUserInfo(socket.userId, (err, userInfo) => {
                            if (err) return;
                            io.to(targetSocketId).emit('friend_request_received', userInfo);
                        });
                    }
                });
            });
        });
    });

    // Arkadaşlık İsteğine Cevap (Kabul Et / Reddet)
    socket.on('respond_to_friend_request', ({ requesterId, accept }) => {
        if (accept) {
            const updateSql = 'UPDATE friendships SET status = ? WHERE user_id1 = ? AND user_id2 = ?';
            db.run(updateSql, ['accepted', requesterId, socket.userId], (err) => {
                if (err) return;
                getFriendList(requesterId, (friends) => {
                    const requesterSocket = connectedUsers[requesterId];
                    if (requesterSocket) io.to(requesterSocket).emit('load_friend_list', friends);
                });
                getFriendList(socket.userId, (friends) => {
                    socket.emit('load_friend_list', friends);
                });
            });
        } else {
            const deleteSql = 'DELETE FROM friendships WHERE user_id1 = ? AND user_id2 = ?';
            db.run(deleteSql, [requesterId, socket.userId]);
        }
    });

    // Mesaj Gönderme
    socket.on('send_message', ({ receiverId, content, type }) => {
        const sql = 'INSERT INTO messages (sender_id, receiver_id, content, type) VALUES (?, ?, ?, ?)';
        db.run(sql, [socket.userId, receiverId, content, type || 'text'], function(err) {
            if (err) return;
            const messageData = { id: this.lastID, senderId: socket.userId, receiverId: receiverId, content: content, type: type || 'text', timestamp: new Date() };
            const receiverSocketId = connectedUsers[receiverId];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('new_message', messageData);
            }
            socket.emit('new_message', messageData);
        });
    });

    // Mesaj Geçmişi İsteği
    socket.on('request_chat_history', ({ friendId }) => {
        const sql = `SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY timestamp ASC`;
        db.all(sql, [socket.userId, friendId, friendId, socket.userId], (err, messages) => {
            if (err) {
                console.error("Mesaj geçmişi alınırken hata:", err);
                socket.emit('error', 'Mesaj geçmişi yüklenirken bir hata oluştu.');
                return;
            }
            socket.emit('chat_history', messages);
        });
    });

    // Kullanıcı Yazıyor Bildirimleri
    socket.on('typing_start', ({ receiverId }) => {
        const receiverSocketId = connectedUsers[receiverId];
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('display_typing', { senderId: socket.userId, isTyping: true });
        }
    });

    socket.on('typing_stop', ({ receiverId }) => {
        const socketId = connectedUsers[receiverId];
        if (socketId) {
            io.to(socketId).emit('display_typing', { senderId: socket.userId, isTyping: false });
        }
    });

    // Sesli/Görüntülü Arama Sinyalleşmesi
    socket.on('call-user', ({ offer, to }) => {
        console.log(`[DEBUG] ${socket.username} kullanıcısı ${to} kullanıcısını arıyor.`);
        const targetSocketId = connectedUsers[to];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call-offer', { offer: offer, from: socket.userId });
        } else {
            socket.emit('call-failed', 'Kullanıcı şu anda çevrimdışı.');
        }
    });

    socket.on('call-answer', ({ answer, to }) => {
        console.log(`[DEBUG] ${socket.username} kullanıcısı ${to} kullanıcısının aramasına cevap veriyor.`);
        const targetSocketId = connectedUsers[to];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call-answer', { answer: answer });
        }
    });

    socket.on('ice-candidate', ({ candidate, to }) => {
        const targetSocketId = connectedUsers[to];
        if (targetSocketId) {
            io.to(targetSocketId).emit('ice-candidate', { candidate: candidate });
        }
    });

    socket.on('end-call', ({ to }) => {
        const targetSocketId = connectedUsers[to];
        if (targetSocketId) {
            io.to(targetSocketId).emit('end-call');
        }
    });

    // Durum Güncellemesi Paylaşma
    socket.on('share_status', (content) => {
        const sql = 'INSERT INTO status_updates (user_id, content) VALUES (?, ?)';
        db.run(sql, [socket.userId, content], function(err) {
            if (err) return;
            getUserInfo(socket.userId, (userInfo) => {
                const statusData = { user: userInfo, content: content, timestamp: new Date() };
                getFriendList(socket.userId, (friends) => {
                    friends.forEach(friend => {
                        const friendSocketId = connectedUsers[friend.id];
                        if (friendSocketId) {
                            io.to(friendSocketId).emit('new_status_update', statusData);
                        }
                    });
                });
            });
        });
    });

    // Profil Güncelleme (Şifre, Takma Ad, Açıklama)
    socket.on('update_profile', async ({ type, value }) => {
        let sql, params;
        if (type === 'nickname') {
            sql = 'UPDATE users SET nickname = ? WHERE id = ?';
            params = [value, socket.userId];
        } else if (type === 'description') {
            sql = 'UPDATE users SET description = ? WHERE id = ?';
            params = [value, socket.userId];
        } else if (type === 'password') {
            const { oldPassword, newPassword } = value;
            const user = await new Promise((resolve, reject) => {
                db.get('SELECT password_hash FROM users WHERE id = ?', [socket.userId], (err, row) => { if (err) reject(err); else resolve(row); });
            });
            const match = await bcrypt.compare(oldPassword, user.password_hash);
            if (!match) {
                socket.emit('error', 'Eski şifreniz hatalı.');
                return;
            }
            const newPasswordHash = await bcrypt.hash(newPassword, 10);
            sql = 'UPDATE users SET password_hash = ? WHERE id = ?';
            params = [newPasswordHash, socket.userId];
        }
        db.run(sql, params, (err) => {
            if (err) {
                socket.emit('error', 'Profil güncellenirken bir hata oluştu.');
                return;
            }
            socket.emit('profile_updated', { type, value: type === 'password' ? null : value });
        });
    });
});

// --- YARDIMCI FONKSİYONLAR ---
function getUserInfo(userId, callback) {
    const sql = 'SELECT id, username, nickname, profile_pic, description FROM users WHERE id = ?';
    db.get(sql, [userId], callback);
}

function getFriendList(userId, callback) {
    const sql = `
        SELECT u.id, u.username, u.nickname, u.profile_pic, u.description
        FROM users u
        JOIN friendships f ON (u.id = f.user_id1 OR u.id = f.user_id2)
        WHERE (f.user_id1 = ? OR f.user_id2 = ?) AND u.id != ? AND f.status = 'accepted'
    `;
    db.all(sql, [userId, userId, userId], (err, rows) => {
        if (err) {
            console.error("[DEBUG] Arkadaş listesi alınırken veritabanı hatası:", err);
            callback(null);
            return;
        }
        const friendsWithStatus = rows.map(friend => {
            return { ...friend, isOnline: connectedUsers.hasOwnProperty(friend.id) };
        });
        callback(friendsWithStatus);
    }
// --- SUNUCUYU BAŞLATMA ---
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
