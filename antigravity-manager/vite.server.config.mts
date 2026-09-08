import { defineConfig } from 'vite';
import path from 'path';

const nativeExternals = ['better-sqlite3', 'keytar', '@napi-rs/keyring'];

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), './src'),
      electron: path.resolve(process.cwd(), './src/mocks/electron-server.ts'),
      kafkajs: path.resolve(process.cwd(), './src/mocks/empty.ts'),
      mqtt: path.resolve(process.cwd(), './src/mocks/empty.ts'),
      amqplib: path.resolve(process.cwd(), './src/mocks/empty.ts'),
      'amqp-connection-manager': path.resolve(process.cwd(), './src/mocks/empty.ts'),
      nats: path.resolve(process.cwd(), './src/mocks/empty.ts'),
      '@fastify/static': path.resolve(process.cwd(), './src/mocks/empty.ts'),
      '@fastify/view': path.resolve(process.cwd(), './src/mocks/empty.ts'),
      '@nestjs/microservices': path.resolve(
        process.cwd(),
        './src/mocks/nestjs-microservices',
      ),
      '@nestjs/websockets': path.resolve(process.cwd(), './src/mocks/nestjs-websockets'),
    },
  },
  build: {
    ssr: 'src/server/standalone.ts',
    target: 'node22',
    outDir: 'dist-server',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      external: nativeExternals,
      output: {
        format: 'cjs',
        entryFileNames: '[name].cjs',
      },
    },
  },
});
