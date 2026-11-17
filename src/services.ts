import { claudeExtractor } from './ai/claude-extractor.js';
import { createEmbedder, type Embedder } from './ai/embeddings.js';
import type { Extractor } from './ai/extraction.js';
import { groqExtractor } from './ai/groq-extractor.js';
import { rulesExtractor } from './ai/rules-extractor.js';
import { baseUrl, type Config, type ExtractorName } from './config.js';
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
    extractor: createExtractor(config),
    links: createLinkSigner(config.linkSecret, baseUrl(config)),
    filing: config.filing,
  };
}

/** The configured extractor, or `name` instead (the eval compares extractors). Throws if its key is missing. */
export function createExtractor(config: Config, name: ExtractorName = config.extractor): Extractor {
  if (name === 'claude') {
    if (!config.anthropicApiKey) throw new Error('The Claude extractor needs ANTHROPIC_API_KEY.');
    return claudeExtractor({ apiKey: config.anthropicApiKey });
  }
  if (name === 'groq') {
    if (!config.groqApiKey) throw new Error('The Groq extractor needs GROQ_API_KEY.');
    return groqExtractor({ apiKey: config.groqApiKey });
  }
  return rulesExtractor();
}
