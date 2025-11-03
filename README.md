# StarVoidEmperors Discord Bots Ecosystem

Multi-bot ecosystem for managing StarVoidEmperors Discord server with shared utilities and centralized management.

## 🏗️ Project Structure

```
StarVoidEmperors/
├── index.js                    # Main launcher - manages all bots
├── bot-config.json            # Bot configuration (production/development)
├── package.json               # Shared dependencies
├── utils/                     # Shared utilities for all bots
│   ├── consoleLogger.js      # Centralized logging system
│   ├── nicknameManagerService.js
│   └── ocrFileUtils.js
├── Stalker/                   # Stalker bot (boss tracking, punishments)
│   ├── index.js
│   ├── config/
│   ├── handlers/
│   ├── services/
│   └── utils/                 # Bot-specific utilities
├── shared_data/               # Shared data between bots
├── logs/                      # Centralized logs
├── eng.traineddata           # OCR training data (English)
└── pol.traineddata           # OCR training data (Polish)
```

## 🚀 Quick Start

### Installation

```bash
# Install dependencies
npm install

# Configure environment
cp Stalker/.env.example Stalker/.env
# Edit Stalker/.env and add your bot token

# Configure servers
# Edit Stalker/config/servers.json with your Discord server settings
```

### Running Bots

```bash
# Run all bots in production mode
npm start

# Run all bots in development mode
npm run local

# Run specific bot only
npm run stalker
```

## 📋 Bot Configuration

Edit `bot-config.json` to control which bots run in each environment:

```json
{
  "production": ["stalker"],
  "development": ["stalker"]
}
```

## 🤖 Available Bots

### Stalker Bot

Multi-server bot for clan management in Survivor.io:
- **Boss participation tracking** using OCR
- **Punishment system** with automatic point management
- **Vacation management** with request system
- **Phase 1-4 tracking** for Survivor.io game modes
- **Multi-server support** with independent configurations

See [Stalker/README.md](Stalker/README.md) for detailed documentation.

## ➕ Adding New Bots

1. **Create bot folder** in the root directory
2. **Add bot to `index.js`** in the `botConfigs` array:

```javascript
const botConfigs = [
    {
        name: 'Your Bot Name',
        loggerName: 'YourBot',
        emoji: '🎮',
        path: './YourBot/index'
    }
    // ... other bots
];
```

3. **Update `bot-config.json`** to include your bot:

```json
{
  "production": ["stalker", "yourbot"],
  "development": ["yourbot"]
}
```

4. **Add npm script** to `package.json`:

```json
{
  "scripts": {
    "yourbot": "cd YourBot && node index.js"
  }
}
```

5. **Use shared utilities** in your bot:

```javascript
const { createBotLogger } = require('../utils/consoleLogger');
```

## 🔧 Shared Utilities

All bots have access to shared utilities in the `utils/` folder:

- **consoleLogger.js** - Centralized logging with colors and timestamps
- **nicknameManagerService.js** - Discord nickname management
- **ocrFileUtils.js** - OCR image processing utilities

## 📝 Environment Variables

Each bot manages its own `.env` file in its folder:

```
BotName/
  └── .env              # Bot-specific environment variables
```

## 🔒 Git Ignore

The following are automatically ignored:
- `node_modules/`
- `*.env` (except `.env.example`)
- `logs/`
- `shared_data/`
- Bot-specific `data/` folders

## 📦 Dependencies

All dependencies are managed in the root `package.json`. Individual bots don't need their own `package.json` files.

## 🛠️ Development

### Local Development

```bash
# Run in development mode (uses development config)
npm run local
```

### Production Deployment

```bash
# Run in production mode
npm start
```

## 📚 Documentation

- [Stalker Bot Documentation](Stalker/README.md)
- [Stalker Setup Guide](Stalker/SETUP_GUIDE.md)
- [Stalker Migration Guide](Stalker/MIGRATION_GUIDE.md)

## 🤝 Contributing

When adding new features or bots:
1. Follow the existing project structure
2. Use shared utilities when possible
3. Document your changes in bot-specific README
4. Update this main README if needed

## 📄 License

ISC

---

Built with ❤️ for StarVoidEmperors community
