const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// База данных создается автоматически в одном файле прямо на сервере
const db = new sqlite3.Database(path.join(__dirname, 'chat_ink.db'), (err) => {
    if (err) console.error('Ошибка SQLite:', err.message);
    else console.log('База данных SQLite успешно запущена!');
});

// Создаем таблицы, если их нет
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

    // Регистрация
    socket.on('register', async ({ name, password }, callback) => {
        const id = await generateUniqueId();
        const date = new Date().toLocaleDateString('ru-RU');
        db.run("INSERT INTO users (id, name, password, createdAt) VALUES (?, ?, ?, ?)", [id, name, password, date], (err) => {
            if (err) return callback({ success: false, message: 'Ошибка регистрации' });
            callback({ success: true, user: { id, name, password, createdAt: date } });
        });
    });

    // Вход
    socket.on('login', ({ id, password }, callback) => {
        db.get("SELECT * FROM users WHERE id = ?", [id], (err, user) => {
            if (user && user.password === password) {
                currentUserId = id;
                activeUsers.add(id);
                socket.join(id);
                socket.join('global_channel');
                io.emit('status_change', { id, online: true });
                callback({ success: true, user });
            } else {
                callback({ success: false, message: 'Неверный ID или пароль' });
            }
        });
    });

    // Восстановление сессии
    socket.on('reconnect_user', (id) => {
        db.get("SELECT id FROM users WHERE id = ?", [id], (err, user) => {
            if (user) {
                currentUserId = id;
                activeUsers.add(id);
                socket.join(id);
                socket.join('global_channel');
                io.emit('status_change', { id, online: true });
            }
        });
    });

    // Загрузка истории
    socket.on('load_history', ({ chatWith }, callback) => {
        if (!currentUserId) return;
        let query, params;

        if (chatWith === 'global') {
            query = "SELECT messages.*, users.name as fromName FROM messages JOIN users ON messages.sender = users.id WHERE recipient = 'global' ORDER BY timestamp ASC";
            params = [];
        } else {
            query = `SELECT messages.*, users.name as fromName FROM messages 
                     JOIN users ON messages.sender = users.id 
                     WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?) 
                     ORDER BY timestamp ASC`;
            params = [currentUserId, chatWith, chatWith, currentUserId];
        }

        db.all(query, params, (err, rows) => {
            if (err) return callback([]);
            const formatted = rows.map(r => ({
                id: r.id, from: r.sender, to: r.recipient, fromName: r.fromName,
                text: r.text, timestamp: r.timestamp, edited: !!r.edited
            }));
            callback(formatted);
        });
    });

    // Статусы
    socket.on('get_statuses', (ids, callback) => {
        const statuses = {};
        ids.forEach(id => statuses[id] = activeUsers.has(id));
        callback(statuses);
    });

    // Поиск контакта
    socket.on('search_contact', (id, callback) => {
        db.get("SELECT id, name FROM users WHERE id = ?", [id], (err, user) => {
            if (user) callback({ success: true, contact: user });
            else callback({ success: false, message: 'Пользователь не найден' });
        });
    });

    // Отправка сообщения
    socket.on('send_message', ({ to, text, adminPassword }) => {
        if (!currentUserId) return;
        if (to === 'global' && adminPassword !== 'Max_092010_m') return;

        const msgId = '_' + Math.random().toString(36).substr(2, 9);
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        db.run("INSERT INTO messages (id, sender, recipient, text, timestamp) VALUES (?, ?, ?, ?, ?)", 
            [msgId, currentUserId, to, text, time], (err) => {
                if (err) return;
                db.get("SELECT name FROM users WHERE id = ?", [currentUserId], (err, user) => {
                    const msg = { id: msgId, from: currentUserId, fromName: user.name, to, text, timestamp: time, edited: false };
                    if (to === 'global') io.to('global_channel').emit('new_message', msg);
                    else io.to(to).to(currentUserId).emit('new_message', msg);
                });
        });
    });

    // Редактирование
    socket.on('edit_message', ({ msgId, newText }) => {
        db.run("UPDATE messages SET text = ?, edited = 1 WHERE id = ? AND sender = ?", [newText, msgId, currentUserId], function(err) {
            if (this.changes > 0) {
                db.get("SELECT * FROM messages WHERE id = ?", [msgId], (err, m) => {
                    db.get("SELECT name FROM users WHERE id = ?", [m.sender], (err, user) => {
                        const updated = { id: m.id, from: m.sender, fromName: user.name, to: m.recipient, text: m.text, timestamp: m.timestamp, edited: true };
                        if (m.recipient === 'global') io.to('global_channel').emit('update_message', updated);
                        else io.to(m.recipient).to(m.sender).emit('update_message', updated);
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
                    if (m.recipient === 'global') io.to('global_channel').emit('message_deleted', msgId);
                    else io.to(m.recipient).to(m.sender).emit('message_deleted', msgId);
                });
            }
        });
    });

    // Профиль
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

    // Удаление аккаунта
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

    socket.on('disconnect', () => {
        if (currentUserId) {
            activeUsers.delete(currentUserId);
            io.emit('status_change', { id: currentUserId, online: false });
        }
    });
});

server.listen(PORT, () => console.log(`Сервер чата запущен на порту ${PORT}`));
