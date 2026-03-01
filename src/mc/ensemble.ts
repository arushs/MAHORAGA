/**
 * Ensemble scoring — combines MC probability, LLM confidence, and sentiment.
 * Stub (to be implemented by Jarvis)
 */

export interface EnsembleWeights {
  mc: number;
  llm: number;
  sentiment: number;
}

export const DEFAULT_WEIGHTS: EnsembleWeights = {
  mc: 0.4,
  llm: 0.4,
  sentiment: 0.2,
};

export interface EnsembleInput {
  mcProbability: number;
  llmConfidence: number;
  sentimentScore: number;
}

/**
 * Compute weighted ensemble score.
 * All inputs should be in [0, 1]. Weights must sum to 1.
 */
export function computeEnsembleScore(
  input: EnsembleInput,
  weights: EnsembleWeights = DEFAULT_WEIGHTS,
): number {
  const { mc, llm, sentiment } = weights;
  const weightSum = mc + llm + sentiment;
  if (Math.abs(weightSum - 1.0) > 1e-6) {
    throw new Error(`Ensemble weights must sum to 1.0, got ${weightSum}`);
  }
  for (const [key, val] of Object.entries(input)) {
    if (val < 0 || val > 1) {
      throw new Error(`${key} must be in [0, 1], got ${val}`);
    }
  }
  return mc * input.mcProbability + llm * input.llmConfidence + sentiment * input.sentimentScore;
}
