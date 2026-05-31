class ChatInkClient {
    constructor() {
        this.currentUser = null;
        this.activePeerId = null;
        this.editingMessageId = null;
        this.ws = null;
        this.contacts = [];
        this.serverUrl = window.location.origin.replace(/^http/, 'ws');
    }

    // Переключение вкладок Вход / Регистрация
    toggleAuthForms(showLogin) {
        document.getElementById('login-form').classList.toggle('hidden', !showLogin);
        document.getElementById('register-form').classList.toggle('hidden', showLogin);
    }

    // Универсальный метод для HTTP запросов
    async req(url, data = null) {
        const opt = data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {};
        const res = await fetch(url, opt);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Ошибка сети');
        return json;
    }

    // РЕГИСТРАЦИЯ
    async register() {
        const name = document.getElementById('reg-name').value.trim();
        const password = document.getElementById('reg-pass').value.trim();
        if (!name || !password) return alert('Заполните все поля');
        try {
            const user = await this.req('/api/register', { name, password });
            alert(`Регистрация успешна! Ваш уникальный ID: ${user.id}`);
            this.toggleAuthForms(true);
            document.getElementById('login-id').value = user.id;
        } catch (e) { alert(e.message); }
    }

    // ВХОД В АККАУНТ
    async login() {
        const id = document.getElementById('login-id').value.trim();
        const password = document.getElementById('login-pass').value.trim();
        try {
            this.currentUser = await this.req('/api/login', { id, password });
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('my-name-display').innerText = this.currentUser.name;
            document.getElementById('my-avatar-letter').innerText = this.currentUser.name.charAt(0).toUpperCase();
            
            this.initWebSocket();
            await this.loadContacts();
        } catch (e) { alert(e.message); }
    }

    // РАБОТА С СЕТЬЮ WEBSOCKET
    initWebSocket() {
        this.ws = new WebSocket(this.serverUrl);
        this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'init', userId: this.currentUser.id }));
        this.ws.onmessage = (e) => {
            const res = JSON.parse(e.data);
            if (res.type === 'msg') {
                if (this.activePeerId && (res.data.to === this.activePeerId || res.data.from === this.activePeerId || (this.activePeerId === '99999' && res.data.to === '99999'))) {
                    this.renderNewMessage(res.data);
                }
            }
            if (res.type === 'edit' && this.activePeerId && (res.data.to === this.activePeerId || res.data.from === this.activePeerId || (this.activePeerId === '99999' && res.data.to === '99999'))) {
                this.loadMessages();
            }
            if (res.type === 'delete' && this.activePeerId) {
                this.loadMessages();
            }
            if (res.type === 'status') {
                const contact = this.contacts.find(c => c.id === res.userId);
                if (contact) contact.online = res.online;
                this.updateContactsUI();
                if (this.activePeerId === res.userId) this.updateChatHeaderStatus(res.online);
            }
        };
        this.ws.onclose = () => setTimeout(() => this.initWebSocket(), 3000);
    }

    // ПОЛУЧЕНИЕ И ОБНОВЛЕНИЕ СПИСКА КОНТАКТОВ СЛЕВА
    async loadContacts() {
        if (!this.currentUser) return;
        try {
            this.contacts = await this.req(`/api/contacts/${this.currentUser.id}`);
            this.updateContactsUI();
        } catch (e) { console.error(e); }
    }

    updateContactsUI() {
        const container = document.getElementById('contacts-container');
        container.innerHTML = '';

        // Принудительно вставляем Общую группу в начало списка контактов
        const groupItem = document.createElement('div');
        groupItem.className = `contact-item ${this.activePeerId === '99999' ? 'active' : ''}`;
        groupItem.onclick = () => this.openChat('99999');
        groupItem.innerHTML = `
            <div class="avatar" style="background: #f59e0b;">📢</div>
            <div class="contact-info">
                <div class="contact-name-row"><strong>Общая группа Ink</strong><span class="contact-id-tag">#Группа</span></div>
                <span class="status-text">все сети</span>
            </div>
        `;
        container.appendChild(groupItem);

        this.contacts.forEach(c => {
            const item = document.createElement('div');
            item.className = `contact-item ${this.activePeerId === c.id ? 'active' : ''}`;
            item.onclick = () => this.openChat(c.id);
            item.innerHTML = `
                <div class="avatar">${c.name.charAt(0).toUpperCase()}</div>
                <div class="contact-info">
                    <div class="contact-name-row"><strong>${c.name}</strong><span class="contact-id-tag">#${c.id}</span></div>
                    <span class="status-text">${c.online ? 'в сети' : 'не в сети'}</span>
                </div>
            `;
            container.appendChild(item);
        });
    }
    // ОТКРЫТИЕ ДИАЛОГА И МОБИЛЬНАЯ АДАПТАЦИЯ
    async openChat(peerId) {
        this.activePeerId = peerId;
        const target = this.contacts.find(c => c.id === peerId);
        
        document.getElementById('chat-welcome').classList.add('hidden');
        document.getElementById('chat-active').classList.remove('hidden');
        
        if (peerId === '99999') {
            document.getElementById('chat-target-name').innerText = "Общая группа Ink";
            this.updateChatHeaderStatus(true);
            document.getElementById('chat-target-status-text').innerText = "все сети";
            document.querySelector('.delete-friend-btn').classList.add('hidden');
        } else {
            document.getElementById('chat-target-name').innerText = target ? target.name : 'Чат';
            this.updateChatHeaderStatus(target ? target.online : false);
            document.querySelector('.delete-friend-btn').classList.remove('hidden');
        }

        // Мобильная вёрстка: переключаем экран на окно чата
        document.getElementById('app-container').classList.add('chat-open');

        this.updateContactsUI();
        this.loadMessages();
    }

    closeChatMobile() {
        document.getElementById('app-container').classList.remove('chat-open');
        this.activePeerId = null;
    }

    updateChatHeaderStatus(online) {
        const dot = document.getElementById('chat-target-status-dot');
        const txt = document.getElementById('chat-target-status-text');
        if (dot) dot.className = `status-dot ${online ? 'online' : 'offline'}`;
        if (txt) txt.innerText = online ? 'в сети' : 'не в сети';
    }

    // РАБОТА С СООБЩЕНИЯМИ
    async loadMessages() {
        if (!this.activePeerId) return;
        const view = document.getElementById('messages-view');
        view.innerHTML = '';
        try {
            const list = await this.req(`/api/messages/${this.currentUser.id}/${this.activePeerId}`);
            list.forEach(m => this.renderNewMessage(m));
        } catch (e) { console.error(e); }
    }

    renderNewMessage(msg) {
        const view = document.getElementById('messages-view');
        const isMy = msg.from === this.currentUser.id;
        
        const old = document.getElementById(`msg-${msg.id}`);
        if (old) old.remove();

        const bubble = document.createElement('div');
        bubble.id = `msg-${msg.id}`;
        bubble.className = `msg-bubble ${isMy ? 'my' : 'peer'}`;
        
        const showSenderName = msg.to === '99999' && !isMy ? `<div style="font-size:11px; font-weight:bold; color:var(--accent); margin-bottom:2px;">${msg.senderName}</div>` : '';
        
        let acts = isMy ? `<span class="msg-actions">
            <span onclick="app.startEdit('${msg.id}','${msg.text.replace(/'/g, "\\'")}')">ред.</span>
            <span onclick="app.deleteMessage('${msg.id}')">удл.</span>
        </span>` : '';

        bubble.innerHTML = `${showSenderName}<div class="msg-text">${msg.text}</div><span class="msg-meta">${msg.edited ? 'изм. ' : ''}${msg.time} ${acts}</span>`;
        view.appendChild(bubble);
        view.scrollTop = view.scrollHeight;
    }

    // ОТПРАВКА, ИЗМЕНЕНИЕ И УДАЛЕНИЕ СООБЩЕНИЙ
    sendMessage() {
        const input = document.getElementById('message-input');
        const text = input.value.trim();
        if (!text) return;

        if (this.editingMessageId) {
            this.ws.send(JSON.stringify({ type: 'edit', userId: this.currentUser.id, msgId: this.editingMessageId, newText: text }));
            this.cancelEdit();
        } else {
            this.ws.send(JSON.stringify({ type: 'message', from: this.currentUser.id, to: this.activePeerId, text }));
        }
        input.value = '';
    }

    startEdit(id, txt) {
        this.editingMessageId = id;
        const panel = document.getElementById('edit-panel');
        if (panel) panel.classList.remove('hidden');
        document.getElementById('message-input').value = txt;
    }

    cancelEdit() {
        this.editingMessageId = null;
        const panel = document.getElementById('edit-panel');
        if (panel) panel.classList.add('hidden');
        document.getElementById('message-input').value = '';
    }

    deleteMessage(id) {
        if (confirm('Удалить сообщение?')) {
            this.ws.send(JSON.stringify({ type: 'delete', userId: this.currentUser.id, msgId: id }));
            setTimeout(() => this.loadMessages(), 200);
        }
    }

    // УПРАВЛЕНИЕ КОНТАКТАМИ (ДРУЗЬЯМИ)
    async addFriend() {
        const friendId = document.getElementById('search-friend-id').value.trim();
        if (!friendId) return;
        try {
            await this.req('/api/add-friend', { userId: this.currentUser.id, friendId });
            document.getElementById('search-friend-id').value = '';
            await this.loadContacts();
        } catch (e) { alert(e.message); }
    }

    async deleteCurrentFriend() {
        if (!this.activePeerId || !confirm('Удалить контакт?')) return;
        try {
            await this.req('/api/delete-friend', { userId: this.currentUser.id, friendId: this.activePeerId });
            this.closeChatMobile();
            document.getElementById('chat-active').classList.add('hidden');
            document.getElementById('chat-welcome').classList.remove('hidden');
            await this.loadContacts();
        } catch (e) { alert(e.message); }
    }

    // ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ
    openProfile() {
        document.getElementById('prof-id').innerText = this.currentUser.id;
        document.getElementById('prof-date').innerText = this.currentUser.createdAt;
        document.getElementById('prof-name-input').value = this.currentUser.name;
        document.getElementById('prof-pass-input').value = '';
        document.getElementById('profile-modal').classList.remove('hidden');
    }

    closeProfile() { document.getElementById('profile-modal').classList.add('hidden'); }

    async saveProfileChanges() {
        const name = document.getElementById('prof-name-input').value.trim();
        const newPassword = document.getElementById('prof-pass-input').value.trim();
        try {
            const data = { id: this.currentUser.id, password: this.currentUser.password, name };
            if (newPassword) data.newPassword = newPassword;
            this.currentUser = await this.req('/api/update-profile', data);
            document.getElementById('my-name-display').innerText = this.currentUser.name;
            this.closeProfile();
            alert('Успешно сохранено');
        } catch (e) { alert(e.message); }
    }

    logout() { location.reload(); }

    async deleteAccount() {
        if (!confirm('Удалить аккаунт навсегда?')) return;
        try {
            await this.req('/api/delete-account', { id: this.currentUser.id, password: this.currentUser.password });
            location.reload();
        } catch (e) { alert(e.message); }
    }

    // ТЕМЫ
    toggleTheme() {
        const body = document.body;
        const isDark = body.classList.toggle('dark-theme');
        body.classList.toggle('light-theme', !isDark);
        document.getElementById('theme-toggle-btn').innerText = isDark ? '☀️' : '🌙';
    }
}

const app = new ChatInkClient();
