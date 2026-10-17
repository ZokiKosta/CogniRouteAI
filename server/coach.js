// AI coaching with Claude. Without an API key (or when the call fails) the
// rule-based coach from shared/coach.js answers instead, in the same shape.
import Anthropic from '@anthropic-ai/sdk';
import { betaJSONSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { COACH_SCHEMA, COACH_SYSTEM_PROMPT, coachingUserMessage, ruleBasedCoaching, summarizeTrip } from '../shared/coach.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export function createCoach({ client, model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL, log = console } = {}) {
  if (client === undefined) {
    const hasKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
    client = hasKey ? new Anthropic() : null;
  }

  async function coach(trip, history = []) {
    const summary = summarizeTrip(trip);
    if (!client) return ruleBasedCoaching(summary, history);
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 16000,
        // If the model declines, the API retries on its default fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: betaJSONSchemaOutputFormat(COACH_SCHEMA) },
        system: COACH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: coachingUserMessage(summary, history) }],
      });
      if (response.stop_reason === 'refusal') throw new Error(`refused (${response.stop_details?.category ?? 'unknown'})`);
      if (!response.parsed_output) throw new Error(`no structured output (stop_reason ${response.stop_reason})`);
      return { ...response.parsed_output, source: 'claude', model: response.model };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) log.warn('[coach] Invalid ANTHROPIC_API_KEY – using rule-based coaching');
      else if (err instanceof Anthropic.RateLimitError) log.warn('[coach] Rate limited by the Claude API – using rule-based coaching');
      else if (err instanceof Anthropic.APIError) log.warn(`[coach] Claude API error ${err.status}: ${err.message}`);
      else log.warn(`[coach] ${err.message}`);
      return { ...ruleBasedCoaching(summary, history), note: 'AI советите не беа достапни, ова се совети според правила.' };
    }
  }

  return { coach, aiEnabled: !!client, model };
}
