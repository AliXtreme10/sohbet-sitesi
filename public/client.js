// public/client.js

// --- Socket.IO BAĞLANTISI ---
const socket = io();

// --- DOM ELEMENTLERİ ---
const views = {
    login: document.getElementById('login-view'),
    register: document.getElementById('register-view'),
    chat: document.getElementById('chat-view'),
    profileSettings: document.getElementById('profile-settings-view')
};

// Login/Register
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const showRegisterLink = document.getElementById('show-register');
const showLoginLink = document.getElementById('show-login');

// Chat View
const myUsernameEl = document.getElementById('my-username');
const myNicknameEl = document.getElementById('my-nickname');
const myProfilePicEl = document.getElementById('my-profile-pic');
const friendListEl = document.getElementById('friend-list');
const activeChatNameEl = document.getElementById('active-chat-name');
const messagesEl = document.getElementById('messages');
const messageInputEl = document.getElementById('message-input');
const sendMessageBtnEl = document.getElementById('send-message-btn');
const addFriendBtnEl = document.getElementById('add-friend-btn');
const profileSettingsBtnEl = document.getElementById('profile-settings-btn');

// Profile Settings
const settingsProfilePicEl = document.getElementById('settings-profile-pic');
const profilePicInputEl = document.getElementById('profile-pic-input');
const settingsNicknameEl = document.getElementById('settings-nickname');
const updateNicknameBtnEl = document.getElementById('update-nickname-btn');
const settingsDescriptionEl = document.getElementById('settings-description');
const updateDescriptionBtnEl = document.getElementById('update-description-btn');
const oldPasswordEl = document.getElementById('old-password');
const newPasswordEl = document.getElementById('new-password');
const newPasswordConfirmEl = document.getElementById('new-password-confirm');
const updatePasswordBtnEl = document.getElementById('update-password-btn');
const backToChatBtnEl = document.getElementById('back-to-chat-btn');

// Modal
const addFriendModal = document.getElementById('add-friend-modal');
const friendUsernameInputEl = document.getElementById('friend-username-input');
const sendFriendRequestBtnEl = document.getElementById('send-friend-request-btn');
const modalCloseBtn = document.querySelector('.close-btn');

// --- GLOBAL STATE ---
let currentUser = null;
let activeChatFriend = null;
let friends = [];

// --- VIEW MANAGEMENT ---
function showView(viewName) {
    Object.values(views).forEach(view => view.classList.remove('active'));
    views[viewName].classList.add('active');
}

// --- NOTIFICATIONS ---
function showNotification(message, type = 'info') {
    const notificationBox = document.getElementById('notification-box');
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    notificationBox.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 5000);
}

// --- EVENT LISTENERS FOR NAVIGATION ---
showRegisterLink.addEventListener('click', (e) => {
    e.preventDefault();
    showView('register');
});

showLoginLink.addEventListener('click', (e) => {
    e.preventDefault();
    showView('login');
});

profileSettingsBtnEl.addEventListener('click', () => {
    loadProfileSettings();
    showView('profileSettings');
});

backToChatBtnEl.addEventListener('click', () => {
    showView('chat');
});

// --- AUTHENTICATION LOGIC ---
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    const response = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const result = await response.json();

    if (result.success) {
        currentUser = result.user;
        socket.emit('user_login', currentUser.id);
        updateUserInfo();
        showView('chat');
    } else {
        showNotification(result.message, 'error');
    }
});

registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('register-username').value;
    const nickname = document.getElementById('register-nickname').value;
    const password = document.getElementById('register-password').value;
    const passwordConfirm = document.getElementById('register-password-confirm').value;

    if (password !== passwordConfirm) {
        showNotification('Şifreler eşleşmiyor!', 'error');
        return;
    }

    const response = await fetch('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, nickname, password })
    });
    const result = await response.json();

    if (result.success) {
        showNotification(result.message, 'success');
        showView('login');
    } else {
        showNotification(result.message, 'error');
    }
});

// --- CHAT LOGIC ---
function updateUserInfo() {
    myUsernameEl.textContent = currentUser.username;
    myNicknameEl.textContent = currentUser.nickname || currentUser.username;
    myProfilePicEl.src = currentUser.profile_pic || '/default.png';
}

function renderFriendList(friendList) {
    friends = friendList;
    friendListEl.innerHTML = '';
    friends.forEach(friend => {
        const li = document.createElement('li');
        li.innerHTML = `
            <img src="${friend.profile_pic || '/default.png'}" alt="${friend.nickname}">
            <span>${friend.nickname || friend.username}</span>
        `;
        li.addEventListener('click', () => startChat(friend));
        friendListEl.appendChild(li);
    });
}

// --- GÜNCELELLENMİŞ startChat FONKSİYONU ---
function startChat(friend) {
    activeChatFriend = friend;
    activeChatNameEl.textContent = `${friend.nickname || friend.username} ile sohbet`;
    messageInputEl.disabled = false;
    sendMessageBtnEl.disabled = false;
    
    document.querySelectorAll('#friend-list li').forEach(item => item.classList.remove('active'));
    event.currentTarget.classList.add('active');

    messagesEl.innerHTML = ''; // Önceki sohbeti temizle

    // Sunucudan bu arkadaşla olan mesaj geçmişini iste
    socket.emit('request_chat_history', { friendId: friend.id });
}

sendMessageBtnEl.addEventListener('click', sendMessage);
messageInputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

function sendMessage() {
    const content = messageInputEl.value.trim();
    if (content && activeChatFriend) {
        socket.emit('send_message', {
            receiverId: activeChatFriend.id,
            content: content,
            type: 'text'
        });
        messageInputEl.value = '';
    }
}

// --- FRIEND MANAGEMENT ---
addFriendBtnEl.addEventListener('click', () => {
    addFriendModal.style.display = 'block';
});

modalCloseBtn.addEventListener('click', () => {
    addFriendModal.style.display = 'none';
});

sendFriendRequestBtnEl.addEventListener('click', () => {
    const friendUsername = friendUsernameInputEl.value.trim();
    if (friendUsername) {
        socket.emit('add_friend', friendUsername);
        friendUsernameInputEl.value = '';
        addFriendModal.style.display = 'none';
    }
});

// --- PROFILE SETTINGS ---
function loadProfileSettings() {
    settingsProfilePicEl.src = currentUser.profile_pic || '/default.png';
    settingsNicknameEl.value = currentUser.nickname || '';
    settingsDescriptionEl.value = currentUser.description || '';
}

profilePicInputEl.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        const formData = new FormData();
        formData.append('profilePic', file);
        formData.append('userId', currentUser.id);

        const response = await fetch('/upload-profile-pic', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (result.success) {
            currentUser.profile_pic = result.profilePic;
            updateUserInfo();
            loadProfileSettings();
            showNotification('Profil fotoğrafı güncellendi!', 'success');
        } else {
            showNotification('Fotoğraf yüklenemedi.', 'error');
        }
    }
});

updateNicknameBtnEl.addEventListener('click', () => {
    const newNickname = settingsNicknameEl.value.trim();
    if (newNickname) {
        socket.emit('update_profile', { type: 'nickname', value: newNickname });
    }
});

updateDescriptionBtnEl.addEventListener('click', () => {
    const newDescription = settingsDescriptionEl.value.trim();
    socket.emit('update_profile', { type: 'description', value: newDescription });
});

updatePasswordBtnEl.addEventListener('click', () => {
    const oldPass = oldPasswordEl.value;
    const newPass = newPasswordEl.value;
    const newPassConfirm = newPasswordConfirmEl.value;

    if (!oldPass || !newPass || !newPassConfirm) {
        showNotification('Tüm şifre alanlarını doldurun.', 'error');
        return;
    }
    if (newPass !== newPassConfirm) {
        showNotification('Yeni şifreler eşleşmiyor.', 'error');
        return;
    }
    socket.emit('update_profile', { type: 'password', value: { oldPassword: oldPass, newPassword: newPass } });
    
    oldPasswordEl.value = '';
    newPasswordEl.value = '';
    newPasswordConfirmEl.value = '';
});

// --- SOCKET.IO LISTENERS (GERÇEK ZAMANLI OLAYLARI DİNLEME) ---
socket.on('load_friend_list', (friendList) => {
    renderFriendList(friendList);
});

socket.on('friend_request_received', (requesterInfo) => {
    const accept = confirm(`${requesterInfo.nickname || requesterInfo.username} (${requesterInfo.username}) sizinle arkadaş olmak istiyor. Kabul ediyor musunuz?`);
    socket.emit('respond_to_friend_request', { requesterId: requesterInfo.id, accept });
});

socket.on('new_message', (message) => {
    const li = document.createElement('li');
    li.textContent = message.content;
    if (message.senderId === currentUser.id) {
        li.classList.add('sent');
    } else {
        li.classList.add('received');
    }
    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;
});

// --- YENİ ÖZELLİK: Mesaj Geçmişi Dinleyicisi ---
socket.on('chat_history', (messages) => {
    messagesEl.innerHTML = ''; // Ekranı temizle
    if (messages.length === 0) {
        // Eğer geçmişte mesaj yoksa bir mesaj gösterebiliriz (isteğe bağlı)
        // messagesEl.innerHTML = '<li class="no-messages">Bu sohbette henüz mesaj yok.</li>';
        return;
    }
    
    messages.forEach(msg => {
        const li = document.createElement('li');
        li.textContent = msg.content;
        if (msg.senderId === currentUser.id) {
            li.classList.add('sent');
        } else {
            li.classList.add('received');
        }
        messagesEl.appendChild(li);
    });
    // En sona otomatik scroll et
    messagesEl.scrollTop = messagesEl.scrollHeight; 
});

socket.on('new_status_update', (statusData) => {
    showNotification(`${statusData.user.nickname || statusData.user.username} durum güncelledi: "${statusData.content}"`);
});

socket.on('profile_updated', (data) => {
    if (data.type === 'nickname') currentUser.nickname = data.value;
    if (data.type === 'description') currentUser.description = data.value;
    updateUserInfo();
    showNotification(`Profiliniz (${data.type}) güncellendi.`, 'success');
});

socket.on('error', (message) => {
    showNotification(message, 'error');
});
