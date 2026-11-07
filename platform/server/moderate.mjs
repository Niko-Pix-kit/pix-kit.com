import { createBackend } from './backend.mjs';
import {
  createModerationRepository, createOpenAIModeration, processModerationJobs,
} from '../moderation/index.mjs';

const {
  SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: publicKey,
  SUPABASE_SECRET_KEY: secretKey, OPENAI_API_KEY: apiKey,
} = process.env;
if (!url || !publicKey || !secretKey || !apiKey) {
  console.error('Moderation requires a configured Supabase project and an approved moderation API key');
  process.exitCode = 1;
} else {
  try {
    const backend = createBackend({ url, publicKey, secretKey });
    const repository = createModerationRepository({ rpc: backend.serviceRpc.bind(backend) });
    const result = await processModerationJobs({ repository, provider: createOpenAIModeration({ apiKey }) });
    console.log('Moderation batch completed', result);
    if (result.failed > 0) process.exitCode = 1;
  } catch {
    console.error('Moderation batch failed; leased items remain private and can be retried');
    process.exitCode = 1;
  }
}
