const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['polling', 'websocket'],
  allowEIO3: true
});

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Session configuration
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // Set to false to work with both HTTP and HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax'
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(express.static('public'));

// Initialize database
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      username VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

initDB().catch(console.error);

// Routes
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username min 3 chars, password min 6 chars' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username',
      [username, hashedPassword]
    );
    
    req.session.userId = result.rows[0].id;
    req.session.username = result.rows[0].username;
    res.json({ 
      success: true, 
      username: result.rows[0].username,
      userId: result.rows[0].id
    });
  } catch (error) {
    if (error.code === '23505') {
      res.status(400).json({ error: 'Username already exists' });
    } else {
      console.error(error);
      res.status(500).json({ error: 'Server error' });
    }
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ 
      success: true, 
      username: user.username,
      userId: user.id
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/check-auth', (req, res) => {
  if (req.session.userId) {
    res.json({ 
      authenticated: true, 
      username: req.session.username,
      userId: req.session.userId
    });
  } else {
    res.json({ authenticated: false });
  }
});

app.get('/messages', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    const result = await pool.query(
      'SELECT username, message, created_at FROM messages ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows.reverse());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// WebSocket
const userSockets = new Map(); // Map userId to socket.id

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  
  // Wait for authentication
  socket.on('authenticate', (data) => {
    if (data && data.userId && data.username) {
      // Disconnect previous socket for this user if exists
      if (userSockets.has(data.userId)) {
        const oldSocketId = userSockets.get(data.userId);
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket && oldSocket.id !== socket.id) {
          console.log('Disconnecting old socket for user:', data.username);
          oldSocket.disconnect(true);
        }
      }
      
      socket.userId = data.userId;
      socket.username = data.username;
      userSockets.set(data.userId, socket.id);
      
      console.log('User authenticated:', socket.username, 'socket:', socket.id);
      socket.emit('authenticated', { success: true });
    } else {
      socket.emit('auth_error', { message: 'Invalid authentication data' });
    }
  });
  
  socket.on('send_message', async (data) => {
    if (!socket.userId || !socket.username) {
      return socket.emit('error', { message: 'Not authenticated' });
    }
    
    try {
      const result = await pool.query(
        'INSERT INTO messages (user_id, username, message) VALUES ($1, $2, $3) RETURNING *',
        [socket.userId, socket.username, data.message]
      );
      
      const message = result.rows[0];
      
      io.emit('new_message', {
        username: message.username,
        message: message.message,
        created_at: message.created_at
      });
      
      console.log('Message sent by', message.username + ':', message.message);
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  socket.on('disconnect', () => {
    if (socket.userId) {
      console.log('User disconnected:', socket.username);
      // Only remove from map if this is the current socket for this user
      if (userSockets.get(socket.userId) === socket.id) {
        userSockets.delete(socket.userId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
