# Tangerine App

A Capacitor mobile app for collecting data via Tangerine server.

## Features

- Two-step login: server URL then credentials
- List user's groups
- List forms per group
- Open forms in in-app browser (WebView)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Add platforms:
   ```bash
   npx cap add android
   npx cap add ios
   ```

3. Run in browser for development:
   ```bash
   npx cap serve
   ```

4. Build native (after modifying `www/`):
   ```bash
   npx cap sync
   npx cap open android   # or ios
   ```

## API Endpoints Expected

- POST `/api/login` → returns `{ token }`
- GET `/api/groups` → returns array of `{ id, name, ... }`
- GET `/api/groups/:id/forms` → returns array of `{ id, name, url, ... }`

Modify `js/api.js` if your server uses different paths.