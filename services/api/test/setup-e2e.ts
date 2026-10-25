import * as dotenv from 'dotenv';
import * as path from 'path';

// Purge any foreign/global Windows environment variables that collide with OmniNovel
if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('Camera_AI')) {
  delete process.env.DATABASE_URL;
}

// Load local project .env if it exists
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });
