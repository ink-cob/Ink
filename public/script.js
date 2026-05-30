const socket = io();

let currentUser = null;
let activeChat = null;
let savedContacts = JSON.parse(localStorage.getItem('chat_ink_contacts')) || {};
let currentChatMessages = [];

// При каждой перезагрузке принудительно очищаем старую сессию и требуем вход
window.onload = () => {
    localStorage.removeItem('chat_ink_user'); // Удаляем сессию
    const savedTheme = localStorage.getItem('chat_ink_theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    // Всегда показываем окно авторизации при старте
    document.getElementById('auth-container').classList.remove('hidden');
    document.getElementById('app-container').classList.add('hidden');
};

function toggleAuth(showLogin) {
    document.getElementById('login-form').classList.toggle('hidden', !showLogin);
    document.getElementById('register-form').classList.toggle('hidden', showLogin);
}

function register() {
    const name = document.getElementById('reg-name').value.trim();
    const password = document.getElementById('reg-pass').value.trim();
    if (!name || !password) return alert('Заполните все поля');

    socket.emit('register', { name, password }, (res) => {
        if (res.success) {
            alert(`Регистрация успешна! Ваш уникальный ID: ${res.user.id}. Запомните его!`);
            toggleAuth(true);
            document.getElementById('login-id').value = res.user.id;
            document.getElementById('login-pass').value = '';
        } else {
            alert(res.message);
        }
    });
}

function login() {
    const id = document.getElementById('login-id').value.trim();
    const password = document.getElementById('login-pass').value.trim();
    if (!id || !password) return alert('Введите ID и пароль');

    socket.emit('login', { id, password }, (res) => {
        if (res.success) {
            currentUser = res.user;
            localStorage.setItem('chat_ink_user', JSON.stringify(currentUser));
            showApp();
        } else {
            alert(res.message);
        }
    });
}

function showApp() {
    document.getElementById('auth-container').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    renderContacts();
    startStatusUpdater();
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const target = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', target);
    localStorage.setItem('chat_ink_theme', target);
}

function searchContact() {
    const id = document.getElementById('search-input').value.trim();
    if (!id) return;
    if (id === currentUser.id) return alert('Вы не можете добавить себя');

    socket.emit('search_contact', id, (res) => {
        if (res.success) {
            savedContacts[id] = res.contact.name;
            localStorage.setItem('chat_ink_contacts', JSON.stringify(savedContacts));
            renderContacts();
            document.getElementById('search-input').value = '';
        } else {
            alert(res.message);
        }
    });
}

function renderContacts() {
    const container = document.getElementById('contacts-list');
    container.innerHTML = ''; // Очищаем полностью, так как общего канала больше нет

    Object.keys(savedContacts).forEach(id => {
        const item = document.createElement('div');
        item.className = 'contact-item';
        item.id = `chat-${id}`;
        item.onclick = () => selectChat(id);
        item.innerHTML = `
            <div class="contact-info">
                <div class="contact-name">${savedContacts[id]} <span class="status-dot offline" id="dot-${id}"></span></div>
                <div style="font-size:11px; color:gray;">ID: ${id}</div>
            </div>
        `;
        container.appendChild(item);
    });
    updateStatuses();
}

function selectChat(id) {
    activeChat = id;
    document.getElementById('chat-blank').classList.add('hidden');
    document.getElementById('chat-active').classList.remove('hidden');
    
    document.getElementById('active-chat-name').innerText = savedContacts[id];
    document.getElementById('active-chat-status').className = 'status-dot';

    document.getElementById('app-container').classList.add('chat-open');

    socket.emit('load_history', { chatWith: id }, (messages) => {
        currentChatMessages = messages;
        renderMessages();
    });
    updateStatuses();
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text) return;

    socket.emit('send_message', { to: activeChat, text });
    input.value = '';
}

socket.on('new_message', (msg) => {
    if (activeChat === msg.to || msg.from === activeChat) {
        currentChatMessages.push(msg);
        renderMessages();
    }
});

function renderMessages() {
    const container = document.getElementById('messages-container');
    container.innerHTML = '';

    currentChatMessages.forEach(m => {
        const isMe = m.from === currentUser.id;
        const div = document.createElement('div');
        div.className = `message ${isMe ? 'out' : 'in'}`;

        let actions = '';
        if (isMe) {
            actions = `
                <span class="msg-actions" onclick="editMsg('${m.id}', '${m.text}')">✏️</span>
                <span class="msg-actions" onclick="deleteMsg('${m.id}')">🗑️</span>
            `;
        }

        div.innerHTML = `
            <div style="font-size:11px;font-weight:bold;color:var(--primary-color)">${m.fromName}</div>
            <div class="msg-text">${m.text}</div>
            <div class="msg-meta">${m.timestamp} ${m.edited ? '(ред.)' : ''} ${actions}</div>
        `;
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

function editMsg(id, oldText) {
    const newText = prompt('Отредактируйте сообщение:', oldText);
    if (newText && newText.trim() !== oldText) {
        socket.emit('edit_message', { msgId: id, newText: newText.trim() });
    }
}

function deleteMsg(id) {
    if (confirm('Удалить это сообщение?')) {
        socket.emit('delete_message', id);
    }
}

socket.on('update_message', (updatedMsg) => {
    currentChatMessages = currentChatMessages.map(m => m.id === updatedMsg.id ? updatedMsg : m);
    renderMessages();
});

socket.on('message_deleted', (id) => {
    currentChatMessages = currentChatMessages.filter(m => m.id !== id);
    renderMessages();
});

function updateStatuses() {
    const ids = Object.keys(savedContacts);
    if (ids.length === 0) return;

    socket.emit('get_statuses', ids, (statuses) => {
        Object.keys(statuses).forEach(id => {
            const dot = document.getElementById(`dot-${id}`);
            const activeDot = document.getElementById('active-chat-status');
            const isOnline = statuses[id];

            if (dot) dot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
            if (activeChat === id && activeDot) activeDot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
        });
    });
}

function startStatusUpdater() {
    setInterval(updateStatuses, 5000);
}

socket.on('status_change', ({ id, online }) => {
    const dot = document.getElementById(`dot-${id}`);
    if (dot) dot.className = `status-dot ${online ? 'online' : 'offline'}`;
    if (activeChat === id) {
        document.getElementById('active-chat-status').className = `status-dot ${online ? 'online' : 'offline'}`;
    }
});

function deleteCurrentFriend() {
    if (activeChat) {
        if (confirm('Удалить этот контакт из списка друзей?')) {
            delete savedContacts[activeChat];
            localStorage.setItem('chat_ink_contacts', JSON.stringify(savedContacts));
            closeChat();
            renderContacts();
        }
    }
}

function closeChat() {
    activeChat = null;
    document.getElementById('app-container').classList.remove('chat-open');
    document.getElementById('chat-active').classList.add('hidden');
    document.getElementById('chat-blank').classList.remove('hidden');
}

// Функции профиля
function openProfile() {
    document.getElementById('prof-id').innerText = currentUser.id;
    document.getElementById('prof-date').innerText = currentUser.createdAt || 'Неизвестно';
    document.getElementById('prof-name').value = currentUser.name;
    document.getElementById('prof-pass').value = currentUser.password;
    document.getElementById('profile-modal').classList.remove('hidden');
}

function closeProfile() {
    document.getElementById('profile-modal').classList.add('hidden');
}

function saveProfile() {
    const name = document.getElementById('prof-name').value.trim();
    const password = document.getElementById('prof-pass').value.trim();
    if (!name || !password) return alert('Поля не могут быть пустыми');

    socket.emit('update_profile', { name, password }, (res) => {
        if (res.success) {
            currentUser = res.user;
            localStorage.setItem('chat_ink_user', JSON.stringify(currentUser));
            alert('Профиль успешно обновлен!');
            closeProfile();
            renderContacts();
        }
    });
}

function deleteAccount() {
    if (confirm('Вы уверены, что хотите полностью удалить аккаунт? Все ваши сообщения и данные сотрутся.')) {
        socket.emit('delete_account', (res) => {
            if (res.success) {
                localStorage.clear();
                location.reload();
            }
        });
    }
}
