<<<<<<< HEAD
# Slot-Stars-Club
Will add later
=======
# 🌟 Slot Stars Club — MVP

## Quick Start

```bash
# Install dependencies
npm install

# Start (development)
npm run dev

# Start (production with PM2)
pm2 start ecosystem.config.js
```

## Default Admin
- **Username:** `admin`
- **Password:** `admin123`
- **URL:** `/admin`

⚠️ Change the admin password immediately after first login via the Users panel.

## Deployment (Debian 12 VPS)

### 1. Install Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Install PM2
```bash
sudo npm install -g pm2
```

### 3. Clone & Install
```bash
git clone <your-repo>
cd slot-stars
npm install
```

### 4. Start with PM2
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### 5. Nginx Config
```bash
sudo cp nginx.conf /etc/nginx/sites-available/slot-stars
sudo ln -s /etc/nginx/sites-available/slot-stars /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## Architecture

```
/
├── server.js          # Express app entry
├── db.js              # SQLite database + schema
├── ecosystem.config.js # PM2 config
├── nginx.conf         # Nginx reverse proxy
├── routes/
│   ├── auth.js        # Register, login, logout
│   ├── game.js        # Slot spin engine
│   ├── admin.js       # Admin API
│   └── reseller.js    # Reseller API
├── middleware/
│   └── auth.js        # requireAuth, requireRole
└── public/
    ├── index.html     # Landing page
    └── pages/
        ├── play.html      # Slot machine
        ├── admin.html     # Admin panel
        └── reseller.html  # Reseller panel
```

## User Flows

### Admin Flow
1. Login at `/admin`
2. Go to Invites → Generate codes
3. Share codes with players/resellers
4. Set users as "reseller" + add `reseller_credits` to fund them

### Reseller Flow  
1. Admin promotes user to `reseller` role
2. Admin adds reseller credits via Users panel
3. Reseller logs into `/reseller`
4. Creates invite codes (costs reseller_credits)
5. Adds credits directly to player usernames

### Player Flow
1. Get invite code from admin/reseller
2. Register at `/` with code
3. Play at `/play` — spacebar or click to spin

## Security Notes
- Change `secret` in `express-session` config in server.js
- Add HTTPS via Let's Encrypt (certbot)
- Passwords are bcrypt hashed

## Payout Table
| Combo | Multiplier |
|-------|------------|
| 7️⃣ 7️⃣ 7️⃣ | 50× bet |
| 💎 💎 💎 | 25× bet |
| ⭐ ⭐ ⭐ | 15× bet |
| 🍒 🍒 🍒 | 10× bet |
| 🍋 🍋 🍋 | 8× bet |
| Any 2 match | 2× bet |
| No match | 0 |
>>>>>>> 9305ba4 (Initial project commit)
