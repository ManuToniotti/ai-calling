# AI Calling

A minimal implementation of an AI calling system using OpenAI's Realtime API and Twilio.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with the following variables:
```
OPENAI_API_KEY=your_openai_api_key
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=your_twilio_phone_number
PORT=3000
```

3. Run the server:
```bash
npm start
```

## Project Structure

- `src/index.js`: Main server file
- `public/index.html`: Simple control panel UI
- `.env`: Environment variables (not included in repository)

## Features

- Make AI-powered phone calls
- Real-time transcription
- Emergency stop functionality
- Simple web interface for control