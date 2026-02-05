const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

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
    res.json({ success: true, username: result.rows[0].username });
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
    res.json({ success: true, username: user.username });
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
    res.json({ authenticated: true, username: req.session.username });
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
io.on('connection', (socket) => {
  console.log('User connected');
  
  socket.on('authenticate', (sessionData) => {
    socket.userId = sessionData.userId;
    socket.username = sessionData.username;
  });
  
  socket.on('send_message', async (data) => {
    if (!socket.userId) {
      return socket.emit('error', { message: 'Not authenticated' });
    }
    
    try {
      await pool.query(
        'INSERT INTO messages (user_id, username, message) VALUES ($1, $2, $3)',
        [socket.userId, socket.username, data.message]
      );
      
      io.emit('new_message', {
        username: socket.username,
        message: data.message,
        created_at: new Date()
      });
    } catch (error) {
      console.error(error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
