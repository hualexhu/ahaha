import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/tools/*.test.ts'], testTimeout: 120000 } });
