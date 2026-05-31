const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Пути к файлам базы данных на сервере
const USERS_FILE = path.join(__dirname, 'users.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// Функции безопасного чтения и записи файлов
function loadData(filePath, defaultData) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {
        console.error("Ошибка чтения файла:", filePath, e);
    }
    return defaultData;
}

function saveData(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error("Ошибка записи файла:", filePath, e);
    }
}

// Загрузка данных при старте
let users = loadData(USERS_FILE, {});
let messages = loadData(MESSAGES_FILE, []);
const activeConnections = {}; // Хранилище активных онлайн-сессий ID -> WebSocket

// Генерация уникального 5-значного ID
function generateUniqueId() {
    let id;
    do {
        id = Math.floor(10000 + Math.random() * 90000).toString();
    } while (users[id]);
    return id;
}

// REST API для авторизации и управления профилем
app.post('/api/register', (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const id = generateUniqueId();
    users[id] = {
        id,
        name,
        password,
        createdAt: new Date().toLocaleDateString(),
        friends: []
    };
    saveData(USERS_FILE, users);
    res.json(users[id]);
});

app.post('/api/login', (req, res) => {
    const { id, password } = req.body;
    const user = users[id];
    if (!user || user.password !== password) {
        return res.status(400).json({ error: 'Неверный ID или пароль' });
    }
    res.json(user);
});

app.post('/api/update-profile', (req, res) => {
    const { id, password, name, newPassword } = req.body;
    const user = users[id];
    if (!user || user.password !== password) return res.status(400).json({ error: 'Ошибка доступа' });
    
    if (name) user.name = name;
    if (newPassword) user.password = newPassword;
    
    saveData(USERS_FILE, users);
    broadcastStatus(id, true);
    res.json(user);
});

app.post('/api/delete-account', (req, res) => {
    const { id, password } = req.body;
    if (!users[id] || users[id].password !== password) return res.status(400).json({ error: 'Ошибка доступа' });
    
    delete users[id];
    messages = messages.filter(m => m.from !== id && m.to !== id);
    saveData(MESSAGES_FILE, messages);

    if (activeConnections[id]) activeConnections[id].close();
    delete activeConnections[id];
    
    Object.values(users).forEach(u => {
        u.friends = u.friends.filter(fId => fId !== id);
    });
    
    saveData(USERS_FILE, users);
    res.json({ success: true });
});

app.post('/api/add-friend', (req, res) => {
    const { userId, friendId } = req.body;
    if (!users[friendId]) return res.status(404).json({ error: 'Пользователь не найден' });
    if (userId === friendId) return res.status(400).json({ error: 'Нельзя добавить себя' });
    
    if (!users[userId].friends.includes(friendId)) users[userId].friends.push(friendId);
    if (!users[friendId].friends.includes(userId)) users[friendId].friends.push(userId);
    
    saveData(USERS_FILE, users);
    res.json({ success: true });
});

app.post('/api/delete-friend', (req, res) => {
    const { userId, friendId } = req.body;
    if (users[userId]) users[userId].friends = users[userId].friends.filter(id => id !== friendId);
    if (users[friendId]) users[friendId].friends = users[friendId].friends.filter(id => id !== userId);
    saveData(USERS_FILE, users);
    res.json({ success: true });
});

app.get('/api/contacts/:id', (req, res) => {
    const user = users[req.params.id];
    if (!user) return res.status(404).json({ error: 'Не найден' });
    
    const contactsData = user.friends.map(fId => ({
        id: fId,
        name: users[fId] ? users[fId].name : 'Удаленный аккаунт',
        online: !!activeConnections[fId]
    }));
    res.json(contactsData);
});

app.get('/api/messages/:user1/:user2', (req, res) => {
    const { user1, user2 } = req.params;
    const filtered = messages.filter(m => 
        (m.from === user1 && m.to === user2) || (m.from === user2 && m.to === user1)
    );
    res.json(filtered);
});

// Живая сеть WebSocket
wss.on('connection', (ws) => {
    let currentUserId = null;

    ws.on('message', (messageStr) => {
        const data = JSON.parse(messageStr);

        if (data.type === 'init') {
            currentUserId = data.userId;
            activeConnections[currentUserId] = ws;
            broadcastStatus(currentUserId, true);
        }

                if (data.type === 'message') {
            // Проверка на сигнал "печатает"
            if (data.isTypingSignal) {
                if (data.to === '99999') {
                    // Сигнал "печатает" в общую группу рассылаем всем, кроме отправителя
                    Object.keys(activeConnections).forEach(uid => {
                        if (uid !== data.from) sendToUser(uid, { type: 'typing', from: '99999', userName: users[data.from]?.name || 'Кто-то' });
                    });
                } else {
                    sendToUser(data.to, { type: 'typing', from: data.from });
                }
                return;
            }

            const prefix = "@@@/Ink/";
            const isGlobalGroup = data.text.startsWith(prefix);
            const cleanText = isGlobalGroup ? data.text.substring(prefix.length).trim() : data.text;

            if (!cleanText) return; // Если после префикса ничего нет, игнорируем

            const msg = {
                id: Math.random().toString(36).substr(2, 9),
                from: data.from,
                to: isGlobalGroup ? '99999' : data.to, // 99999 — ID общей группы
                text: cleanText,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                edited: false,
                senderName: users[data.from]?.name || 'Удаленный аккаунт' // Нужно для отображения в группе
            };

            messages.push(msg);
            saveData(MESSAGES_FILE, messages);

            if (isGlobalGroup) {
                // Рассылаем сообщение ОГЛАСКОЙ всем активным пользователям
                Object.keys(activeConnections).forEach(uid => {
                    sendToUser(uid, { type: 'msg', data: msg });
                });
            } else {
                // Обычная отправка тет-а-тет
                sendToUser(data.to, { type: 'msg', data: msg });
                sendToUser(data.from, { type: 'msg', data: msg });
            }
        }


        if (data.type === 'edit') {
            const msg = messages.find(m => m.id === data.msgId && m.from === data.userId);
            if (msg) {
                msg.text = data.newText;
                msg.edited = true;
                saveData(MESSAGES_FILE, messages);
                
                sendToUser(msg.to, { type: 'edit', data: msg });
                sendToUser(msg.from, { type: 'edit', data: msg });
            }
        }

        if (data.type === 'delete') {
            const index = messages.findIndex(m => m.id === data.msgId && m.from === data.userId);
            if (index !== -1) {
                const msg = messages[index];
                messages.splice(index, 1);
                saveData(MESSAGES_FILE, messages);
                
                sendToUser(msg.to, { type: 'delete', msgId: data.msgId });
                sendToUser(msg.from, { type: 'delete', msgId: data.msgId });
            }
        }
    });

    ws.on('close', () => {
        if (currentUserId) {
            delete activeConnections[currentUserId];
            broadcastStatus(currentUserId, false);
        }
    });
});

function sendToUser(userId, obj) {
    if (activeConnections[userId] && activeConnections[userId].readyState === WebSocket.OPEN) {
        activeConnections[userId].send(JSON.stringify(obj));
    }
}

function broadcastStatus(userId, online) {
    Object.values(activeConnections).forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'status', userId, online }));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));

