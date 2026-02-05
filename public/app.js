let socket;
let isLoginMode = true;
let currentUser = null;
let currentUserId = null; // Add userId storage

// DOM Elements
const authContainer = document.getElementById('authContainer');
const chatContainer = document.getElementById('chatContainer');
const authForm = document.getElementById('authForm');
const authTitle = document.getElementById('authTitle');
const authButton = document.getElementById('authButton');
const toggleAuthMode = document.getElementById('toggleAuthMode');
const toggleText = document.getElementById('toggleText');
const toggleLink = document.getElementById('toggleLink');
const errorMessage = document.getElementById('errorMessage');
const currentUsername = document.getElementById('currentUsername');
const logoutBtn = document.getElementById('logoutBtn');
const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');

// Check authentication on load
checkAuth();

// Auth form submission
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  
  const endpoint = isLoginMode ? '/login' : '/register';
  
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      currentUser = data.username;
      currentUserId = data.userId; // Store userId
      showChat();
      initSocket();
      loadMessages();
    } else {
      showError(data.error);
    }
  } catch (error) {
    showError('Ошибка подключения к серверу');
  }
});

// Toggle between login and register
toggleAuthMode.addEventListener('click', toggleMode);
toggleLink.addEventListener('click', toggleMode);

function toggleMode() {
  isLoginMode = !isLoginMode;
  
  if (isLoginMode) {
    authTitle.textContent = 'Вход';
    authButton.textContent = 'Войти';
    toggleAuthMode.textContent = 'Регистрация';
    toggleText.innerHTML = 'Нет аккаунта? <a id="toggleLink">Зарегистрируйтесь</a>';
    document.getElementById('password').setAttribute('autocomplete', 'current-password');
  } else {
    authTitle.textContent = 'Регистрация';
    authButton.textContent = 'Зарегистрироваться';
    toggleAuthMode.textContent = 'Вход';
    toggleText.innerHTML = 'Уже есть аккаунт? <a id="toggleLink">Войдите</a>';
    document.getElementById('password').setAttribute('autocomplete', 'new-password');
  }
  
  // Re-attach event listener
  document.getElementById('toggleLink').addEventListener('click', toggleMode);
  hideError();
}

// Logout
logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/logout', { method: 'POST' });
    
    // Clean up socket
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
    
    socketAuthenticated = false;
    showAuth();
    messagesContainer.innerHTML = '';
    currentUser = null;
    currentUserId = null;
  } catch (error) {
    console.error('Logout error:', error);
  }
});

// Send message
sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  const message = messageInput.value.trim();
  
  if (!message) return;
  
  if (!socket || !socket.connected) {
    console.error('Socket not connected');
    alert('Нет подключения к серверу. Попробуйте обновить страницу.');
    return;
  }
  
  if (!socketAuthenticated) {
    console.error('Socket not authenticated');
    alert('Идет подключение... Попробуйте еще раз через пару секунд.');
    return;
  }
  
  console.log('Sending message:', message);
  socket.emit('send_message', { message });
  messageInput.value = '';
  messageInput.style.height = 'auto';
}

// Auto-resize textarea
messageInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// Socket initialization
let socketAuthenticated = false;

function initSocket() {
  // Prevent multiple socket connections
  if (socket && socket.connected) {
    console.log('Socket already connected');
    return;
  }
  
  // Clean up existing socket if any
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  
  socket = io({
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5
  });
  
  socket.on('connect', () => {
    console.log('Connected to server, socket ID:', socket.id);
    socketAuthenticated = false;
    
    // Authenticate immediately with stored credentials
    if (currentUser && currentUserId) {
      console.log('Authenticating with userId:', currentUserId, 'username:', currentUser);
      socket.emit('authenticate', {
        userId: currentUserId,
        username: currentUser
      });
    }
    
    updateConnectionStatus(true);
  });
  
  socket.on('authenticated', (data) => {
    console.log('Socket authenticated successfully');
    socketAuthenticated = true;
    updateConnectionStatus(true); // Update status after authentication
  });
  
  socket.on('auth_error', (error) => {
    console.error('Authentication error:', error);
    socketAuthenticated = false;
    alert('Ошибка аутентификации. Попробуйте перезайти.');
  });
  
  socket.on('disconnect', (reason) => {
    console.log('Disconnected from server, reason:', reason);
    socketAuthenticated = false;
    updateConnectionStatus(false);
  });
  
  socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    updateConnectionStatus(false);
  });
  
  socket.on('new_message', (data) => {
    console.log('New message received:', data);
    addMessage(data.username, data.message, data.created_at);
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
    alert('Ошибка: ' + error.message);
  });
}

function updateConnectionStatus(connected) {
  const statusEl = document.getElementById('connectionStatus');
  if (statusEl) {
    if (connected && socketAuthenticated) {
      statusEl.textContent = '● Подключено';
      statusEl.style.color = '#4caf50';
    } else if (connected) {
      statusEl.textContent = '● Подключение...';
      statusEl.style.color = '#ff9800';
    } else {
      statusEl.textContent = '● Отключено';
      statusEl.style.color = '#f44336';
    }
  }
}

// Load messages
async function loadMessages() {
  try {
    console.log('Loading messages...');
    const response = await fetch('/messages');
    
    if (!response.ok) {
      throw new Error('Failed to load messages');
    }
    
    const messages = await response.json();
    console.log('Loaded messages:', messages.length);
    
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
      addMessage(msg.username, msg.message, msg.created_at, false);
    });
    scrollToBottom();
  } catch (error) {
    console.error('Failed to load messages:', error);
    messagesContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">Не удалось загрузить сообщения</div>';
  }
}

// Add message to UI
function addMessage(username, message, timestamp, scroll = true) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';
  
  const time = new Date(timestamp).toLocaleTimeString('ru-RU', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  
  messageDiv.innerHTML = `
    <div class="username">${escapeHtml(username)}</div>
    <div class="text">${escapeHtml(message)}</div>
    <div class="time">${time}</div>
  `;
  
  messagesContainer.appendChild(messageDiv);
  
  if (scroll) {
    scrollToBottom();
  }
}

// Utility functions
function showAuth() {
  authContainer.classList.remove('hidden');
  chatContainer.style.display = 'none';
}

function showChat() {
  authContainer.classList.add('hidden');
  chatContainer.style.display = 'flex';
  currentUsername.textContent = currentUser;
  messageInput.focus();
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
}

function hideError() {
  errorMessage.classList.add('hidden');
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function checkAuth() {
  try {
    const response = await fetch('/check-auth');
    const data = await response.json();
    
    if (data.authenticated) {
      currentUser = data.username;
      currentUserId = data.userId; // Store userId
      showChat();
      initSocket();
      loadMessages();
    } else {
      showAuth();
    }
    
    return data;
  } catch (error) {
    showAuth();
    return { authenticated: false };
  }
}
