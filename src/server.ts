import type { Plugin } from '@opencode-ai/plugin';
import * as accounts from './accounts/index.js';
import * as auth from './auth/index.js';
import * as codex from './codex/fetch.js';
import { ALLOWED_MODELS, OAUTH_DUMMY_KEY, PROVIDER_ID } from './config.js';
import * as oauth from './oauth/index.js';

const plugin: Plugin = async (_) => {
  await accounts.load();
  await auth.bootstrap();
  await auth.reconcile();
  await auth.sync();

  accounts.subscribe(() => {
    void auth.sync();
  });

  const codexFetch = codex.create();

  return {
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        if (ctx.auth?.type !== 'oauth') return provider.models;
        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(([, model]) => {
              if (ALLOWED_MODELS.has(model.api.id)) return true;
              const match = model.api.id.match(/^gpt-(\d+\.\d+)/);
              return match ? parseFloat(match[1]!) > 5.4 : false;
            })
            .map(([modelID, model]) => [
              modelID,
              {
                ...model,
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: model.id.includes('gpt-5.5')
                  ? { context: 400_000, input: 272_000, output: 128_000 }
                  : model.limit,
              },
            ]),
        );
      },
    },
    auth: {
      provider: PROVIDER_ID,
      async loader() {
        return { apiKey: OAUTH_DUMMY_KEY, fetch: codexFetch };
      },
      methods: oauth.methods(),
    },
    async event({ event }) {
      const type = (event as { type?: string }).type;
      if (type === 'session.created' || type === 'session.idle') {
        await auth.reconcile();
      }
    },
  };
};

export default {
  id: 'opencode-codex',
  server: plugin,
};
