/**
 * One in-memory MongoDB per test file: some tests change server-wide parameters, which must not leak into files
 * running in parallel. TCP only, so nothing lands in a shared /tmp socket, with a generous start timeout for a busy
 * machine.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { BrainEntry } from '../brain/model.js';

let server: MongoMemoryServer | null = null;

export async function startMongo(): Promise<string> {
  server = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000, args: ['--nounixsocket'] } });
  return server.getUri();
}

export async function stopMongo(): Promise<void> {
  await server?.stop();
  server = null;
}

export async function setupTestDb(): Promise<void> {
  await mongoose.connect(await startMongo());
  await BrainEntry.init();
}

export async function teardownTestDb(): Promise<void> {
  await mongoose.disconnect();
  await stopMongo();
}

export async function clearTestDb(): Promise<void> {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
}
