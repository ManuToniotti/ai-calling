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
    let currentResponseId = null;
    let currentMessageId = null;
    let isFirstMessage = true;
    let completeMessage = '';

    function createSystemMessage(customPrompt) {
      const baseMessage = `You are an AI assistant making phone calls. 
Focus on these key points:
1. You are ALWAYS the caller, never pretend to be the receiving end
2. Stay focused on the specific task provided in the prompt
3. Be direct and professional
4. If you reach the task's objective or need to end:
   - Politely conclude
   - Thank them for their time
   - End with [END_CALL]`;

      return customPrompt 
        ? `${baseMessage}\n\nYOUR SPECIFIC TASK:\n${customPrompt}\n\nRemember: Complete this task exactly as specified. Do not deviate from the given objective.`
        : baseMessage;
    }

    function logConversation(role, message) {
      // Only log complete thoughts/sentences
      if (message.trim() && message.match(/[.!?]$/)) {
        console.log(`${role}: ${message.trim()}`);
        conversation.push({ role, content: message.trim() });
      }
    }

    // Initialize OpenAI connection
    function initializeOpenAI() {
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
                threshold: 0.5
              },
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              voice: VOICE,
              instructions: createSystemMessage(customPrompt),
              modalities: ["text", "audio"]
            }
          };
          
          openAiWs.send(JSON.stringify(sessionUpdate));
        });

        openAiWs.on('message', async (data) => {
          try {
            const response = JSON.parse(data.toString());
            
            // Only log significant events
            if (['session.created', 'session.updated', 'error'].includes(response.type)) {
              console.log('OpenAI event:', response.type);
            }

            switch (response.type) {
              case 'response.created':
                currentResponseId = response.response.id;
                break;

              case 'response.output_item.added':
                if (response.item) {
                  currentMessageId = response.item.id;
                }
                break;

              case 'input_audio_buffer.speech_started':
                if (openAiWs.readyState === WebSocket.OPEN) {
                  console.log('User speaking - interrupting assistant');
                  if (currentResponseId) {
                    openAiWs.send(JSON.stringify({
                      type: 'response.cancel',
                      response_id: currentResponseId
                    }));
                  }
                  
                  if (currentMessageId) {
                    openAiWs.send(JSON.stringify({
                      type: 'conversation.item.truncate',
                      item_id: currentMessageId,
                      content_index: 0,
                      audio_end_ms: Date.now()
                    }));
                  }
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
                  completeMessage += response.delta;
                  
                  // Only log when we have a complete thought/sentence
                  if (completeMessage.match(/[.!?](\s|$)/)) {
                    logConversation('assistant', completeMessage);
                    completeMessage = '';
                  }
                  
                  if (completeMessage.includes('[END_CALL]')) {
                    console.log('Call ending sequence detected');
                    
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

              case 'response.done':
                currentResponseId = null;
                currentMessageId = null;
                break;

              case 'conversation.item.input_audio_transcription.completed':
                if (response.transcript) {
                  logConversation('user', response.transcript.trim());
                }
                break;

              case 'error':
                console.error('OpenAI error:', response.error);
                break;
            }
          } catch (error) {
            console.error('Error handling OpenAI message:', error);
          }
        });

        openAiWs.on('error', (error) => {
          console.error('OpenAI WebSocket error:', error);
        });

        openAiWs.on('close', (code, reason) => {
          console.log('OpenAI WebSocket closed:', code, reason ? reason.toString() : '');
          
          // Log final conversation for record keeping
          if (conversation.length > 0) {
            console.log('Final conversation transcript:');
            conversation.forEach(msg => {
              console.log(`${msg.role}: ${msg.content}`);
            });
          }
        });

      } catch (error) {
        console.error('Error initializing OpenAI connection:', error);
      }
    }

    // Handle messages from Twilio
    connection.on('message', async function handleMessage(rawMessage) {
      try {
        const data = JSON.parse(rawMessage.toString());
        
        // Only log non-media messages
        if (data.event !== 'media') {
          console.log('Twilio event:', data.event);
        }

        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            console.log('Media stream started:', streamSid);
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