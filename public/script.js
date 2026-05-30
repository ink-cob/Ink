const socket = io();

let currentUser = null;
let activeChat = null;
let savedContacts = JSON.parse(localStorage.getItem('chat_ink_contacts')) || {};
let currentChatMessages = [];

window.onload = () => {
    const savedTheme = localStorage.getItem('chat_ink_theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);

    const savedUser = localStorage.getItem('chat_ink_user');
    if (savedUser) {
        currentUser = JSON.parse(savedUser);
        socket.emit('reconnect_user', currentUser.id);
        showApp();
    }
};

function toggleAuth(showLogin) {
    document.getElementById('login-form').classList.toggle('hidden', !showLogin);
    document.getElementById('register-form').classList.toggle('hidden', showLogin);
}

function register() {
    const name = document.getElementById('reg-name').value;
    const password = document.getElementById('reg-pass').value;
    if (!name || !password) return alert('Заполните все поля');

    socket.emit('register', { name, password }, (res) => {
        if (res.success) {
            alert(`Регистрация успешна! Ваш уникальный ID: ${res.user.id}. Запомните его!`);
            toggleAuth(true);
            document.getElementById('login-id').value = res.user.id;
        }
    });
}

function login() {
    const id = document.getElementById('login-id').value;
    const password = document.getElementById('login-pass').value;

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
    const items = container.querySelectorAll('.contact-item:not(#chat-global)');
    items.forEach(el => el.remove());

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
    
    const isGlobal = id === 'global';
    document.getElementById('active-chat-name').innerText = isGlobal ? '📢 Общий канал' : savedContacts[id];
    document.getElementById('delete-friend-btn').classList.toggle('hidden', isGlobal);
    document.getElementById('active-chat-status').className = isGlobal ? 'hidden' : 'status-dot';
    document.getElementById('admin-pass-input').classList.toggle('hidden', !isGlobal);

    // Добавлено: Активация мобильного режима (скрываем контакты, показываем чат)
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

    const adminPassword = document.getElementById('admin-pass-input').value;
    socket.emit('send_message', { to: activeChat, text, adminPassword });
    input.value = '';
}

socket.on('new_message', (msg) => {
    if (activeChat === msg.to || (msg.to === 'global' && activeChat === 'global') || (msg.from === activeChat && msg.to === currentUser.id)) {
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
    if (activeChat && activeChat !== 'global') {
        if (confirm('Удалить этот контакт?')) {
            delete savedContacts[activeChat];
            localStorage.setItem('chat_ink_contacts', JSON.stringify(savedContacts));
            document.getElementById('chat-active').classList.add('hidden');
            document.getElementById('chat-blank').classList.remove('hidden');
            activeChat = null;
            renderContacts();
        }
    }
}

function openProfile() {
    document.getElementById('prof-id').innerText = currentUser.id;
    document.getElementById('prof-date').innerText = currentUser.createdAt || 'Неизвестно';
    document.getElementById('prof-name').value = currentUser.name;
    document.getElementById('prof-pass').value = currentUser.password;
    document.getElementById('profile-modal').classList.remove('hidden');
}

// Функция выхода из чата обратно к списку контактов (для мобильных телефонов)
function closeChat() {
    activeChat = null;
    // Убираем класс мобильного режима, чтобы снова показать список контактов
    document.getElementById('app-container').classList.remove('chat-open');
    document.getElementById('chat-active').classList.add('hidden');
    document.getElementById('chat-blank').classList.remove('hidden');
}

function deleteAccount() {
    if (confirm('Вы уверены, что хотите удалить аккаунт? Это действие удалит все ваши сообщения на сервере.')) {
        socket.emit('delete_account', (res) => {
            if (res.success) {
                localStorage.clear();
                location.reload();
            }
        });
    }
}
// Функция закрытия модального окна профиля
function closeProfile() {
    document.getElementById('profile-modal').classList.add('hidden');
}
