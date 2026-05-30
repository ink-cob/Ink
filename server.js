const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Стало (пример):
const pool = new Pool({
    connectionString: 'postgresql://postgres.mcwrrzxocnncikfnvvgy:max092010M_m@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?', 
    ssl: { rejectUnauthorized: false }
});

// Инициализация таблиц при запуске сервера
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                password TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                sender TEXT NOT NULL,
                recipient TEXT NOT NULL,
                text TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                edited INTEGER DEFAULT 0
            );
        `);
        console.log('База данных Supabase успешно инициализирована.');
    } catch (err) {
        console.error('Ошибка инициализации базы данных:', err.message);
    }
}
initDB();

let activeUsers = new Set();
app.use(express.static(path.join(__dirname, 'public')));

async function generateUniqueId() {
    while (true) {
        const id = Math.floor(10000 + Math.random() * 90000).toString();
        const res = await pool.query("SELECT id FROM users WHERE id = $1", [id]);
        if (res.rows.length === 0) return id;
    }
}

io.on('connection', (socket) => {
    let currentUserId = null;

    // Регистрация
    socket.on('register', async ({ name, password }, callback) => {
        try {
            const id = await generateUniqueId();
            const date = new Date().toLocaleDateString('ru-RU');
            await pool.query("INSERT INTO users (id, name, password, created_at) VALUES ($1, $2, $3, $4)", [id, name, password, date]);
            callback({ success: true, user: { id, name, password, createdAt: date } });
        } catch (err) {
            callback({ success: false, message: 'Ошибка регистрации' });
        }
    });

    // Вход
    socket.on('login', async ({ id, password }, callback) => {
        try {
            const res = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
            const user = res.rows[0];
            if (user && user.password === password) {
                currentUserId = id;
                activeUsers.add(id);
                socket.join(id);
                socket.join('global_channel');
                io.emit('status_change', { id, online: true });
                callback({ success: true, user: { id: user.id, name: user.name, password: user.password, createdAt: user.created_at } });
            } else {
                callback({ success: false, message: 'Неверный ID или пароль' });
            }
        } catch (err) {
            callback({ success: false, message: 'Ошибка авторизации' });
        }
    });

    // Восстановление сессии
    socket.on('reconnect_user', async (id) => {
        const res = await pool.query("SELECT id FROM users WHERE id = $1", [id]);
        if (res.rows.length > 0) {
            currentUserId = id;
            activeUsers.add(id);
            socket.join(id);
            socket.join('global_channel');
            io.emit('status_change', { id, online: true });
        }
    });

    // История чата
    socket.on('load_history', async ({ chatWith }, callback) => {
        if (!currentUserId) return callback([]);
        try {
            let query, params;
            if (chatWith === 'global') {
                query = `SELECT m.*, u.name as "fromName" FROM messages m 
                         JOIN users u ON m.sender = u.id 
                         WHERE m.recipient = 'global' ORDER BY m.timestamp ASC`;
                params = [];
            } else {
                query = `SELECT m.*, u.name as "fromName" FROM messages m 
                         JOIN users u ON m.sender = u.id 
                         WHERE (m.sender = $1 AND m.recipient = $2) OR (m.sender = $2 AND m.recipient = $1) 
                         ORDER BY m.timestamp ASC`;
                params = [currentUserId, chatWith];
            }
            const res = await pool.query(query, params);
            const formatted = res.rows.map(r => ({
                id: r.id, from: r.sender, to: r.recipient, fromName: r.fromName,
                text: r.text, timestamp: r.timestamp, edited: r.edited === 1
            }));
            callback(formatted);
        } catch (err) {
            callback([]);
        }
    });

    // Статусы контактов
    socket.on('get_statuses', (ids, callback) => {
        const statuses = {};
        ids.forEach(id => statuses[id] = activeUsers.has(id));
        callback(statuses);
    });

    // Поиск контакта
    socket.on('search_contact', async (id, callback) => {
        const res = await pool.query("SELECT id, name FROM users WHERE id = $1", [id]);
        if (res.rows.length > 0) callback({ success: true, contact: res.rows[0] });
        else callback({ success: false, message: 'Пользователь не найден' });
    });

    // Отправка сообщений
    socket.on('send_message', async ({ to, text, adminPassword }) => {
        if (!currentUserId) return;
        if (to === 'global' && adminPassword !== 'Max_092010_m') return;

        const msgId = '_' + Math.random().toString(36).substr(2, 9);
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        await pool.query("INSERT INTO messages (id, sender, recipient, text, timestamp) VALUES ($1, $2, $3, $4, $5)", [msgId, currentUserId, to, text, time]);
        const userRes = await pool.query("SELECT name FROM users WHERE id = $1", [currentUserId]);
        
        const msg = { id: msgId, from: currentUserId, fromName: userRes.rows[0].name, to, text, timestamp: time, edited: false };
        if (to === 'global') io.to('global_channel').emit('new_message', msg);
        else io.to(to).to(currentUserId).emit('new_message', msg);
    });

    // Изменение сообщений
    socket.on('edit_message', async ({ msgId, newText }) => {
        const res = await pool.query("UPDATE messages SET text = $1, edited = 1 WHERE id = $2 AND sender = $3 RETURNING *", [newText, msgId, currentUserId]);
        if (res.rows.length > 0) {
            const m = res.rows[0];
            const userRes = await pool.query("SELECT name FROM users WHERE id = $1", [m.sender]);
            const updated = { id: m.id, from: m.sender, fromName: userRes.rows[0].name, to: m.recipient, text: m.text, timestamp: m.timestamp, edited: true };
            if (m.recipient === 'global') io.to('global_channel').emit('update_message', updated);
            else io.to(m.recipient).to(m.sender).emit('update_message', updated);
        }
    });

    // Удаление сообщений
    socket.on('delete_message', async (msgId) => {
        const check = await pool.query("SELECT * FROM messages WHERE id = $1 AND sender = $2", [msgId, currentUserId]);
        if (check.rows.length > 0) {
            const m = check.rows[0];
            await pool.query("DELETE FROM messages WHERE id = $1", [msgId]);
            if (m.recipient === 'global') io.to('global_channel').emit('message_deleted', msgId);
            else io.to(m.recipient).to(m.sender).emit('message_deleted', msgId);
        }
    });

    // Обновление профиля
    socket.on('update_profile', async ({ name, password }, callback) => {
        if (!currentUserId) return;
        await pool.query("UPDATE users SET name = $1, password = $2 WHERE id = $3", [name, password, currentUserId]);
        const res = await pool.query("SELECT * FROM users WHERE id = $1", [currentUserId]);
        const u = res.rows[0];
        callback({ success: true, user: { id: u.id, name: u.name, password: u.password, createdAt: u.created_at } });
    });

    // Удаление аккаунта и сообщений
    socket.on('delete_account', async (callback) => {
        if (!currentUserId) return;
        const id = currentUserId;
        await pool.query("DELETE FROM users WHERE id = $1", [id]);
        await pool.query("DELETE FROM messages WHERE sender = $1 OR recipient = $1", [id]);
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

server.listen(PORT, () => console.log(`Сервер запущен`));
