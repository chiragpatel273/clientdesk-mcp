import { claudeExtractor } from './ai/claude-extractor.js';
import { createEmbedder, type Embedder } from './ai/embeddings.js';
import type { Extractor } from './ai/extraction.js';
import { rulesExtractor } from './ai/rules-extractor.js';
import { baseUrl, type Config } from './config.js';
import { createLinkSigner, type LinkSigner } from './documents/links.js';
import { createFileStore, type FileStore } from './storage/files.js';

/** Everything beyond the database that tools and routes need. Built once at start-up; tests build fakes. */
export interface AppServices {
  files: FileStore;
  embedder: Embedder;
  extractor: Extractor;
  links: LinkSigner;
  filing: { threshold: number; margin: number };
}

export function createServices(config: Config): AppServices {
  return {
    files: createFileStore(config),
    embedder: createEmbedder(config),
    extractor: config.extractor === 'claude' ? claudeExtractor({ apiKey: config.anthropicApiKey }) : rulesExtractor(),
    links: createLinkSigner(config.linkSecret, baseUrl(config)),
    filing: config.filing,
  };
}
