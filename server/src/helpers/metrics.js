// Plain in-process counters. No dependencies.
// Singleton: import { metrics } from "../helpers/metrics.js".

class Metrics {
  constructor() {
    this._counters = {
      chatRequests: 0,
      llmCalls: 0,
      llmRetries: 0,
      roundCapHits: 0,
      finishMismatches: 0,
      finishNudges: 0,
    };
    this._tools = {}; // { [toolName]: { calls, errors } }
  }

  inc(name) {
    if (!(name in this._counters)) this._counters[name] = 0;
    this._counters[name] += 1;
  }

  toolCall(name) {
    if (!this._tools[name]) this._tools[name] = { calls: 0, errors: 0 };
    this._tools[name].calls += 1;
  }

  toolError(name) {
    if (!this._tools[name]) this._tools[name] = { calls: 0, errors: 0 };
    this._tools[name].errors += 1;
  }

  snapshot() {
    const result = {
      chatRequests: this._counters.chatRequests,
      llmCalls: this._counters.llmCalls,
      llmRetries: this._counters.llmRetries,
      roundCapHits: this._counters.roundCapHits,
      finishMismatches: this._counters.finishMismatches,
      finishNudges: this._counters.finishNudges,
      toolCalls: this._tools,
    };
    console.log(result);
    return result;
  }
}

export const metrics = new Metrics();
