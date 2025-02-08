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

// First, let's create a proper prompt mapping
const streamToCallSid = new Map();
const activeCallPrompts = new Map();

// Update make-call endpoint
fastify.post('/make-call', async (request, reply) => {
  const { phoneNumber, prompt } = request.body;

  try {
    console.log('Making call with prompt:', prompt);
    const call = await twilioClient.calls.create({
      url: `https://${request.headers.host}/incoming-call?prompt=${encodeURIComponent(prompt)}`,  // Add prompt to URL
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      method: 'GET'
    });
    
    // Store the prompt with timestamp
    activeCallPrompts.set(call.sid, {
      prompt,
      timestamp: new Date(),
      used: false  // Track if prompt has been used
    });
    console.log('Stored prompt for call:', call.sid);
    
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
  const callSid = request.query.CallSid;
  const prompt = request.query.prompt;
  
  console.log('Incoming call with SID:', callSid);

  // Escape XML special characters
  const escapeXml = (unsafe) => {
    return unsafe.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case "'": return '&apos;';
        case '"': return '&quot;';
      }
    });
  };

  const escapedPrompt = prompt ? escapeXml(prompt) : '';

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream">
          <Parameter name="CallSid" value="${callSid}"/>
          <Parameter name="Prompt" value="${escapedPrompt}"/>
        </Stream>
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
    let completeMessage = '';
    let isSpeaking = false;

    function createSystemMessage(customPrompt) {
      return customPrompt || 'No specific task provided.';
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
          let prompt = null;
    
          // Check for prompt in various places
          if (streamSid) {
            const callSid = streamToCallSid.get(streamSid);
            if (callSid) {
              const storedPromptData = activeCallPrompts.get(callSid);
              if (storedPromptData && !storedPromptData.used) {
                prompt = storedPromptData.prompt;
                storedPromptData.used = true;  // Mark as used
                console.log('Using stored prompt for call:', prompt);
              }
            }
          }
    
          // Create comprehensive system message
          const systemMessage = `${SYSTEM_MESSAGE}
          
          Your specific task for this call is: ${prompt || 'No specific task provided.'}
          
          Remember to:
          1. Focus on completing this specific task
          2. Be professional and courteous
          3. End the call appropriately when the task is complete`;
          
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
              instructions: systemMessage,
              modalities: ["text", "audio"]
            }
          };
          
          openAiWs.send(JSON.stringify(sessionUpdate));
        });
    

        openAiWs.on('message', async (data) => {
          try {
            const response = JSON.parse(data.toString());

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
                  isSpeaking = true;
                  if (openAiWs.readyState === WebSocket.OPEN) {
                    console.log('User started speaking - canceling AI response');
                    
                    // If there's a current incomplete message, save it
                    if (completeMessage.trim()) {
                      conversation.push({ role: 'assistant', content: completeMessage.trim() });
                      completeMessage = '';
                    }

                    // Send cancel response
                    openAiWs.send(JSON.stringify({
                      type: 'response.cancel'
                    }));

                    // Clear the media buffer
                    if (streamSid) {
                      connection.send(JSON.stringify({
                        event: 'clear',
                        streamSid: streamSid
                      }));
                    }
                  }
                  break;

                case 'input_audio_buffer.speech_stopped':
                  isSpeaking = false;
                  // The conversation can continue naturally after user stops speaking
                  break;

                case 'conversation.item.input_audio_transcription.completed':
                  if (response.transcript) {
                    const userMessage = response.transcript.trim();
                    if (userMessage) {
                      console.log('User:', userMessage);
                      // Add user message to conversation history
                      conversation.push({ role: 'user', content: userMessage });
                    }
                  }
                  break;

              case 'response.audio_transcript.delta':
                if (response.delta) {
                  completeMessage += response.delta;
                  
                  if (completeMessage.match(/[.!?](\s|$)/)) {
                    console.log('Assistant:', completeMessage.trim());
                    conversation.push({ role: 'assistant', content: completeMessage.trim() });
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

              case 'conversation.item.input_audio_transcription.completed':
                if (response.transcript) {
                  const userMessage = response.transcript.trim();
                  if (userMessage) {
                    console.log('User:', userMessage);
                    conversation.push({ role: 'user', content: userMessage });
                  }
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
          
          // Clean up maps
          const callSid = streamToCallSid.get(streamSid);
          if (callSid) {
            activeCallPrompts.delete(callSid);
            streamToCallSid.delete(streamSid);
          }

          // Log final conversation
          if (conversation.length > 0) {
            console.log('\nFinal conversation transcript:');
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
        
        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            // Get CallSid from start event's customParameters
            const callSid = data.start.customParameters?.CallSid;
            const promptFromParams = data.start.customParameters?.Prompt;
            
            if (callSid) {
              streamToCallSid.set(streamSid, callSid);
              console.log('Mapped stream', streamSid, 'to call', callSid);
              
              // If we have a prompt in parameters but not in storage, store it
              if (promptFromParams && !activeCallPrompts.has(callSid)) {
                activeCallPrompts.set(callSid, {
                  prompt: promptFromParams,
                  timestamp: new Date(),
                  used: false
                });
              }
            }
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