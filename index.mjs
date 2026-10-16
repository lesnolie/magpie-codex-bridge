import { normalizeEndpoint, relayRequest } from './src/relay.mjs';

export const PROVIDER_ID = 'chatgpt-web';
export const MODEL_ID = 'web';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:18721/v1';

function endpoint() {
  return normalizeEndpoint(process.env.CHATGPT_WEB_ADAPTER_URL || DEFAULT_ENDPOINT);
}

function tokenOf(auth) {
  if (auth?.type === 'api') return auth.key || '';
  return auth?.access || '';
}

// The provider is a protocol adapter, NOT an MCP controller for another Codex process.
// No fake browser login and no unauthorized ChatGPT Web request scraping occur here.
export const ChatGPTWebProvider = async () => ({
  config: async (config) => {
    config.provider ??= {};
    const previous = config.provider[PROVIDER_ID] || {};
    config.provider[PROVIDER_ID] = {
      ...previous,
      name: 'ChatGPT Web (experimental)',
      npm: '@ai-sdk/openai-compatible',
      api: endpoint(),
      models: {
        [MODEL_ID]: {
          name: 'ChatGPT Web (adapter required)',
          reasoning: false,
          attachment: true,
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 128000, output: 16384 },
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        },
        ...(previous.models || {}),
      },
    };
  },
  auth: {
    provider: PROVIDER_ID,
    maxConcurrency: 1,
    methods: [{ type: 'api', label: 'Local adapter access key (not a ChatGPT login)', placeholder: 'adapter-local-key' }],
    async loader(getAuth) {
      return {
        baseURL: endpoint(),
        async fetch(input, init) {
          const auth = await getAuth();
          const key = tokenOf(auth);
          if (!key) throw new Error('Missing local adapter access key; use magpie plugin login chatgpt-web. This is NOT a ChatGPT Web login.');
          return relayRequest({ endpoint: endpoint(), input, init, key });
        },
      };
    },
  },
  'chat.headers': async (input, output) => {
    const id = input?.model?.providerID || input?.provider?.info?.id || input?.message?.model?.providerID;
    if (id !== PROVIDER_ID) return;
    if (typeof input.sessionID === 'string' && input.sessionID) {
      output.headers['x-chatgpt-web-session'] = input.sessionID;
    }
  },
});
