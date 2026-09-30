// Strategy registry. Each strategy is an async generator with the same signature:
//   generateReply({ apiKey, model, messages, maxWords, temperature, signal })
// yielding {type:'word',...} events then one {type:'end',...}.
import { generateReply as v1 } from './v1-253.js';
import { generateReply as buckets } from './buckets.js';
import { generateReply as tournament } from '../../src/generate.js';

export const STRATEGIES = {
  'v1-253': { generate: v1, variant: 'v1-253' },
  'tournament-1020': { generate: tournament, variant: 'tournament-1020' },
  buckets: { generate: buckets, variant: 'buckets-1019' },
};

// Backwards-compatible aliases.
STRATEGIES['253'] = STRATEGIES['v1-253'];
STRATEGIES.tournament = STRATEGIES['tournament-1020'];
