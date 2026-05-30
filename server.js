const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Автоматическое создание локальной базы данных в файле chat_ink.db
const db = new sqlite3.Database(path.join(__dirname, 'chat_ink.db'), (err) => {
    if (err) console.error('Ошибка SQLite:', err.message);
    else console.log('База данных SQLite успешно запущена!');
});

// Создание таблиц пользователей и сообщений
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        password TEXT,
        createdAt TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT,
        recipient TEXT,
        text TEXT,
        timestamp TEXT,
        edited INTEGER DEFAULT 0
    )`);
});

let activeUsers = new Set();
app.use(express.static(path.join(__dirname, 'public')));

// Генерация уникального 5-значного ID
function generateUniqueId() {
    return new Promise((resolve) => {
        const checkId = () => {
            const id = Math.floor(10000 + Math.random() * 90000).toString();
            db.get("SELECT id FROM users WHERE id = ?", [id], (err, row) => {
                if (!row) resolve(id);
                else checkId();
            });
        };
        checkId();
    });
}

io.on('connection', (socket) => {
    let currentUserId = null;

    // Регистрация нового аккаунта
    socket.on('register', async ({ name, password }, callback) => {
        const id = await generateUniqueId();
        const date = new Date().toLocaleDateString('ru-RU');
        db.run("INSERT INTO users (id, name, password, createdAt) VALUES (?, ?, ?, ?)", [id, name, password, date], (err) => {
            if (err) return callback({ success: false, message: 'Ошибка регистрации' });
            callback({ success: true, user: { id, name, password, createdAt: date } });
        });
    });

    // Авторизация (Вход)
    socket.on('login', ({ id, password }, callback) => {
        db.get("SELECT * FROM users WHERE id = ?", [id], (err, user) => {
            if (user && user.password === password) {
                currentUserId = id;
                activeUsers.add(id);
                socket.join(id);
                io.emit('status_change', { id, online: true });
                callback({ success: true, user });
            } else {
                callback({ success: false, message: 'Неверный ID или пароль' });
            }
        });
    });

    // Уведомление о подключении (для актуализации статуса)
    socket.on('reconnect_user', (id) => {
        db.get("SELECT id FROM users WHERE id = ?", [id], (err, user) => {
            if (user) {
                currentUserId = id;
                activeUsers.add(id);
                socket.join(id);
                io.emit('status_change', { id, online: true });
            }
        });
    });

    // Загрузка истории личного чата
    socket.on('load_history', ({ chatWith }, callback) => {
        if (!currentUserId) return;

        const query = `SELECT messages.*, IFNULL(users.name, 'Удаленный аккаунт') as fromName 
                       FROM messages 
                       LEFT JOIN users ON messages.sender = users.id 
                       WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?) 
                       ORDER BY timestamp ASC`;
        const params = [currentUserId, chatWith, chatWith, currentUserId];

        db.all(query, params, (err, rows) => {
            if (err) return callback([]);
            const formatted = rows.map(r => ({
                id: r.id, 
                from: r.sender, 
                to: r.recipient, 
                fromName: r.fromName,
                text: r.text, 
                timestamp: r.timestamp, 
                edited: !!r.edited
            }));
            callback(formatted);
        });
    });

    // Получение текущих статусов списка контактов (онлайн/оффлайн)
    socket.on('get_statuses', (ids, callback) => {
        const statuses = {};
        ids.forEach(id => statuses[id] = activeUsers.has(id));
        callback(statuses);
    });

    // Поиск контакта по 5-значному ID
    socket.on('search_contact', (id, callback) => {
        db.get("SELECT id, name FROM users WHERE id = ?", [id], (err, user) => {
            if (user) callback({ success: true, contact: user });
            else callback({ success: false, message: 'Пользователь не найден' });
        });
    });

    // Отправка сообщения в личный чат
    socket.on('send_message', ({ to, text }) => {
        if (!currentUserId) return;

        const msgId = '_' + Math.random().toString(36).substr(2, 9);
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        db.run("INSERT INTO messages (id, sender, recipient, text, timestamp) VALUES (?, ?, ?, ?, ?)", 
            [msgId, currentUserId, to, text, time], (err) => {
                if (err) return;
                db.get("SELECT name FROM users WHERE id = ?", [currentUserId], (err, user) => {
                    const name = user ? user.name : 'Пользователь';
                    const msg = { id: msgId, from: currentUserId, fromName: name, to, text, timestamp: time, edited: false };
                    
                    // Отправляем сообщение получателю и отправителю
                    io.to(to).to(currentUserId).emit('new_message', msg);
                });
        });
    });

    // Редактирование сообщения
    socket.on('edit_message', ({ msgId, newText }) => {
        db.run("UPDATE messages SET text = ?, edited = 1 WHERE id = ? AND sender = ?", [newText, msgId, currentUserId], function(err) {
            if (this.changes > 0) {
                db.get("SELECT * FROM messages WHERE id = ?", [msgId], (err, m) => {
                    db.get("SELECT name FROM users WHERE id = ?", [m.sender], (err, user) => {
                        const name = user ? user.name : 'Пользователь';
                        const updated = { id: m.id, from: m.sender, fromName: name, to: m.recipient, text: m.text, timestamp: m.timestamp, edited: true };
                        
                        io.to(m.recipient).to(m.sender).emit('update_message', updated);
                    });
                });
            }
        });
    });

    // Удаление сообщения
    socket.on('delete_message', (msgId) => {
        db.get("SELECT * FROM messages WHERE id = ?", [msgId], (err, m) => {
            if (m && m.sender === currentUserId) {
                db.run("DELETE FROM messages WHERE id = ?", [msgId], () => {
                    io.to(m.recipient).to(m.sender).emit('message_deleted', msgId);
                });
            }
        });
    });

    // Обновление профиля (Смена имени и пароля)
    socket.on('update_profile', ({ name, password }, callback) => {
        if (!currentUserId) return;
        db.run("UPDATE users SET name = ?, password = ? WHERE id = ?", [name, password, currentUserId], (err) => {
            if (!err) {
                db.get("SELECT * FROM users WHERE id = ?", [currentUserId], (err, user) => {
                    callback({ success: true, user });
                });
            }
        });
    });

    // Полное удаление аккаунта и всей его истории сообщений
    socket.on('delete_account', (callback) => {
        if (!currentUserId) return;
        const id = currentUserId;
        db.serialize(() => {
            db.run("DELETE FROM users WHERE id = ?", [id]);
            db.run("DELETE FROM messages WHERE sender = ? OR recipient = ?", [id, id]);
        });
        activeUsers.delete(id);
        io.emit('status_change', { id, online: false });
        callback({ success: true });
    });

    // Отключение пользователя
    socket.on('disconnect', () => {
        if (currentUserId) {
            activeUsers.delete(currentUserId);
            io.emit('status_change', { id: currentUserId, online: false });
        }
    });
});

server.listen(PORT, () => console.log(`Сервер мессенджера запущен на порту ${PORT}`));
