import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyWs from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import twilio from 'twilio';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Constants
const VOICE = 'alloy';
const PORT = process.env.PORT || 3000;
const SYSTEM_MESSAGE = `You are an AI assistant making phone calls. Always be clear, professional, and focused on the conversation objective.
When the conversation is complete or needs to end:
1. Politely conclude the conversation
2. Thank them for their time
3. Say goodbye
4. Add [END_CALL] at the very end (do not say this out loud)`;

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Initialize Fastify
const fastify = Fastify({ logger: true });

// Register plugins
fastify.register(fastifyWs, {
  options: { maxPayload: 1048576 }
});

// Register static file serving
fastify.register(staticPlugin, {
  root: path.join(__dirname, '../public'),
  prefix: '/'
});

// Health check route
fastify.get('/health', async (request, reply) => {
  reply.send({ status: 'ok' });
});

// Store active calls and their prompts
const activeCallPrompts = new Map();

// Make call endpoint
fastify.post('/make-call', async (request, reply) => {
  const { phoneNumber, prompt } = request.body;

  try {
    const call = await twilioClient.calls.create({
      url: `https://${request.headers.host}/incoming-call`,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      method: 'GET',
      customParameters: {
        prompt: prompt
      }
    });
    
    // Store the prompt for this call
    activeCallPrompts.set(call.sid, prompt);

    reply.send({ callSid: call.sid });
  } catch (error) {
    console.error('Error making call:', error);
    reply.code(500).send({ error: 'Failed to initiate call' });
  }
});

// Emergency stop endpoint
fastify.post('/emergency-stop', async (request, reply) => {
  const { callSid } = request.body;

  try {
    // End the Twilio call
    await twilioClient.calls(callSid).update({ status: 'completed' });
    
    // The WebSocket connections will be cleaned up by their respective close handlers
    reply.send({ success: true });
  } catch (error) {
    console.error('Error stopping call:', error);
    reply.code(500).send({ error: 'Failed to stop call' });
  }
});

// Twilio webhook route for incoming calls
fastify.all('/incoming-call', async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  
  reply.type('text/xml').send(twimlResponse);
});

// WebSocket handler for media streaming
fastify.register(async function (fastify) {
    fastify.get('/media-stream', { websocket: true }, function wsHandler(connection, req) {
      console.log('New WebSocket connection established');
      
      let streamSid = null;
      let openAiWs = null;
      let conversation = [];
      let assistantMessageBuffer = '';
      let mediaMessageCount = 0; // Counter for media messages
  
      // Handle messages from Twilio
      connection.on('message', async function handleMessage(rawMessage) {
        try {
          const data = JSON.parse(rawMessage.toString());
          
          // Only log non-media messages or every 50th media message
          if (data.event !== 'media' || mediaMessageCount % 50 === 0) {
            console.log('Received Twilio message:', data.event);
          }
          
          if (data.event === 'media') {
            mediaMessageCount++;
          }
  
          switch (data.event) {
            case 'start':
              streamSid = data.start.streamSid;
              console.log('Media stream started:', streamSid);
              
              // Initialize OpenAI connection with retry logic
              initializeOpenAI();
              break;
  
            case 'media':
              if (openAiWs?.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({
                  type: 'input_audio_buffer.append',
                  audio: data.media.payload
                }));
              }
              break;
  
            case 'stop':
              console.log('Media stream stopped');
              if (openAiWs?.readyState === WebSocket.OPEN) {
                openAiWs.close();
              }
              break;
          }
        } catch (error) {
          console.error('Error handling Twilio message:', error);
        }
      });
  
      // Initialize OpenAI with retry logic
      function initializeOpenAI(retryCount = 0) {
        try {
          openAiWs = new WebSocket(
            'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
            {
              headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
              }
            }
          );
  
          openAiWs.on('open', () => {
            console.log('Connected to OpenAI');
            const customPrompt = activeCallPrompts.get(streamSid);
            
            const sessionUpdate = {
              type: 'session.update',
              session: {
                turn_detection: { 
                  type: 'server_vad',
                  threshold: 0.2,
                  patience: 1.0
                },
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                voice: VOICE,
                instructions: customPrompt ? `${SYSTEM_MESSAGE}\n\nSpecific task: ${customPrompt}` : SYSTEM_MESSAGE,
                modalities: ["text", "audio"],
                temperature: 0.8,
              }
            };
            
            openAiWs.send(JSON.stringify(sessionUpdate));
          });
  
          openAiWs.on('message', async (data) => {
            try {
              const response = JSON.parse(data.toString());
              
              // Only log non-audio events
              if (response.type !== 'response.audio.delta') {
                console.log('OpenAI event:', response.type);
              }
  
              switch (response.type) {
                case 'error':
                  console.error('OpenAI error:', response);
                  if (retryCount < 3) {
                    console.log(`Retrying OpenAI connection (attempt ${retryCount + 1})...`);
                    setTimeout(() => initializeOpenAI(retryCount + 1), 1000);
                  }
                  break;
  
                case 'input_audio_buffer.speech_started':
                  if (openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
                  }
                  break;
  
                case 'response.audio.delta':
                  if (response.delta && streamSid) {
                    connection.send(JSON.stringify({
                      event: 'media',
                      streamSid: streamSid,
                      media: { payload: response.delta }
                    }));
                  }
                  break;
  
                case 'response.audio_transcript.delta':
                  if (response.delta) {
                    assistantMessageBuffer += response.delta;
                    console.log('Assistant message:', assistantMessageBuffer);
                    
                    if (assistantMessageBuffer.includes('[END_CALL]')) {
                      console.log('Call ending sequence detected');
                      const cleanMessage = assistantMessageBuffer.replace('[END_CALL]', '').trim();
                      conversation.push({ role: 'assistant', content: cleanMessage });
                      
                      setTimeout(() => {
                        if (connection.socket) {
                          connection.socket.close();
                        }
                        if (openAiWs?.readyState === WebSocket.OPEN) {
                          openAiWs.close();
                        }
                      }, 3000);
                    }
                  }
                  break;
  
                case 'conversation.item.input_audio_transcription.completed':
                  if (response.transcript) {
                    conversation.push({ role: 'user', content: response.transcript.trim() });
                    console.log('User said:', response.transcript.trim());
                  }
                  break;
              }
            } catch (error) {
              console.error('Error handling OpenAI message:', error);
            }
          });
  
          openAiWs.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
            if (retryCount < 3) {
              console.log(`Retrying OpenAI connection (attempt ${retryCount + 1})...`);
              setTimeout(() => initializeOpenAI(retryCount + 1), 1000);
            }
          });
  
          openAiWs.on('close', (code, reason) => {
            console.log('OpenAI WebSocket closed:', code, reason ? reason.toString() : '');
            if (code !== 1000 && retryCount < 3) {
              console.log(`Retrying OpenAI connection (attempt ${retryCount + 1})...`);
              setTimeout(() => initializeOpenAI(retryCount + 1), 1000);
            }
          });
  
        } catch (error) {
          console.error('Error initializing OpenAI connection:', error);
          if (retryCount < 3) {
            console.log(`Retrying OpenAI connection (attempt ${retryCount + 1})...`);
            setTimeout(() => initializeOpenAI(retryCount + 1), 1000);
          }
        }
      }
  
      // Handle WebSocket closure
      connection.on('close', () => {
        console.log('Twilio WebSocket closed');
        if (openAiWs?.readyState === WebSocket.OPEN) {
          openAiWs.close();
        }
        if (streamSid) {
          activeCallPrompts.delete(streamSid);
        }
      });
    });
  });

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server is running on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();