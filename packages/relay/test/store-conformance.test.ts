import { MemoryStore } from '../src/store/memory-store.js';
import { runStoreConformance } from './store-conformance-suite.js';

runStoreConformance('MemoryStore', () => Promise.resolve(new MemoryStore()));
