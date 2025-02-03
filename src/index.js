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
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('New WebSocket connection established');
    
    // Initialize variables for this connection
    let streamSid = null;
    let openAiWs = null;
    let conversation = [];
    let assistantMessageBuffer = '';

    // Initialize OpenAI WebSocket connection
    const initializeOpenAI = () => {
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
        // Send session configuration after connection
        sendSessionUpdate();
      });

      openAiWs.on('error', (error) => {
        console.error('OpenAI WebSocket error:', error);
      });

      openAiWs.on('message', handleOpenAIMessage);

      openAiWs.on('close', () => {
        console.log('OpenAI WebSocket closed');
      });
    };

    // Send session configuration to OpenAI
    const sendSessionUpdate = () => {
      try {
        // Get the custom prompt for this call if it exists
        const customPrompt = streamSid ? activeCallPrompts.get(streamSid) : null;
        
        const instructions = customPrompt 
          ? `${SYSTEM_MESSAGE}\n\nSpecific task: ${customPrompt}`
          : SYSTEM_MESSAGE;

        const sessionUpdate = {
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad' },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: VOICE,
            instructions: instructions,
            modalities: ["text", "audio"],
            temperature: 0.8,
          }
        };
        
        console.log('Sending session update to OpenAI');
        openAiWs.send(JSON.stringify(sessionUpdate));
      } catch (error) {
        console.error('Error sending session update:', error);
      }
    };

    // Handle messages from OpenAI
    const handleOpenAIMessage = async (data) => {
      try {
        const response = JSON.parse(data);
        
        // Log important events for debugging
        if (response.type !== 'response.audio.delta') {
          console.log('OpenAI event:', response.type);
        }

        // Handle different types of responses
        switch (response.type) {
          case 'input_audio_buffer.speech_started':
            // Cancel any ongoing response when user starts speaking
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
            }
            break;

          case 'response.audio.delta':
            // Forward audio to Twilio
            if (response.delta && streamSid) {
              connection.socket.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: response.delta }
              }));
            }
            break;

          case 'response.audio_transcript.delta':
            if (response.delta) {
              assistantMessageBuffer += response.delta;
              
              // Check for end of conversation
              if (assistantMessageBuffer.includes('[END_CALL]')) {
                const cleanMessage = assistantMessageBuffer.replace('[END_CALL]', '').trim();
                conversation.push({ role: 'assistant', content: cleanMessage });
                
                // Close connections after a short delay
                setTimeout(() => {
                  if (connection.socket.readyState === WebSocket.OPEN) {
                    connection.socket.close();
                  }
                  if (openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.close();
                  }
                }, 2000);
              }
            }
            break;

          case 'conversation.item.input_audio_transcription.completed':
            if (response.transcript) {
              conversation.push({ role: 'user', content: response.transcript.trim() });
            }
            break;
        }
      } catch (error) {
        console.error('Error handling OpenAI message:', error);
      }
    };

    // Handle messages from Twilio
    connection.socket.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            console.log('Media stream started:', streamSid);
            // Initialize OpenAI connection when stream starts
            initializeOpenAI();
            break;

          case 'media':
            // Forward audio data to OpenAI
            if (openAiWs?.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              }));
            }
            break;

          case 'stop':
            console.log('Media stream stopped');
            // Clean up connections
            if (openAiWs?.readyState === WebSocket.OPEN) {
              openAiWs.close();
            }
            break;
        }
      } catch (error) {
        console.error('Error handling Twilio message:', error);
      }
    });

    // Handle WebSocket closure
    connection.socket.on('close', () => {
      console.log('Twilio WebSocket closed');
      if (openAiWs?.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
      
      // Clean up stored prompt
      if (streamSid) {
        activeCallPrompts.delete(streamSid);
      }
      
      // Log final conversation if needed
      if (conversation.length > 0) {
        console.log('Final conversation:', JSON.stringify(conversation, null, 2));
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