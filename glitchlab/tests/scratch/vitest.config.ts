import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/scratch/*.test.ts'], testTimeout: 120000 } });
