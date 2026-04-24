import { z } from 'zod';
import { resolveTheme } from '../theme/resolver.js';
import { ThemeDecisionStore, loadCatalog } from '../theme/catalog.js';
import type { Tool } from '../core/tool.js';

const InputSchema = z.object({
  bundle: z.any(),
  /** When true, don't persist the decision. Useful for --dry-run previews. */
  preview: z.boolean().optional(),
}).passthrough();

const OutputSchema = z.object({
  treatmentId: z.string(),
  paletteId: z.string(),
  fontPairingId: z.string(),
  source: z.enum(['explicit', 'agent', 'mood', 'keywords', 'fallback']),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * `resolve-theme` runs the deterministic theme resolver over a bundle and returns
 * the concrete (treatment, palette, fonts). Idempotent: persists the decision
 * under data/theme-decisions.json so future calls return the same result.
 */
export const resolveThemeTool: Tool<Input, Output> = {
  name: 'resolve-theme',
  description: 'Resolve a ContentBundle to a concrete treatment + palette + fonts. Deterministic per bundle.id; persists the decision.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  composes: ['render-slide-video'],
  examples: [
    {
      description: 'Resolve (and persist) the theme for a bundle. Subsequent calls return the same (treatment, palette, fonts).',
      input: {},
    },
    {
      description: 'Preview-only resolution: compute the theme without writing it to data/theme-decisions.json (safe during --dry-run).',
      input: { preview: true },
    },
  ],

  async run(input) {
    const resolved = resolveTheme(input.bundle, { persist: !input.preview });
    return {
      treatmentId: resolved.treatment.id,
      paletteId: resolved.palette.id,
      fontPairingId: resolved.fontPairing.id,
      source: resolved.source,
    };
  },
};

// ────────────────────────────────────────────────────────────────────────────
// choose-theme: agent-facing override tool.
// ────────────────────────────────────────────────────────────────────────────

const ChooseInputSchema = z.object({
  bundle: z.any(),
  treatmentId: z.string(),
  paletteId: z.string().optional(),
  fontPairingId: z.string().optional(),
  decidedBy: z.string().optional(),
}).passthrough();

const ChooseOutputSchema = z.object({
  bundleId: z.string(),
  treatmentId: z.string(),
  source: z.literal('agent'),
});

type ChooseInput = z.infer<typeof ChooseInputSchema>;
type ChooseOutput = z.infer<typeof ChooseOutputSchema>;

/**
 * `choose-theme` is how an external agent (LLM) locks in a theme decision for a
 * specific bundle. The choice is persisted, so subsequent renders pick it up
 * without re-invoking the agent. Validates the treatmentId against the catalog
 * so the agent can't invent a non-existent treatment.
 */
export const chooseThemeTool: Tool<ChooseInput, ChooseOutput> = {
  name: 'choose-theme',
  description: 'An agent-facing override: persist a specific treatment choice for bundle.id. Must be a known treatment. Idempotent.',
  inputSchema: ChooseInputSchema,
  outputSchema: ChooseOutputSchema,
  composes: ['render-slide-video'],
  examples: [
    {
      description: 'Lock a treatment choice for this bundle so future renders reuse it (no palette/font override).',
      input: { treatmentId: 'hero-display' },
    },
    {
      description: 'Pin treatment, palette, and font pairing together (full agent decision).',
      input: { treatmentId: 'midnight', paletteId: 'midnight-deep', fontPairingId: 'serif-modern', decidedBy: 'agent-v1' },
    },
  ],

  async preflight(input) {
    const catalog = loadCatalog();
    const treatmentIds = new Set(catalog.treatments.map(t => t.id));
    if (!treatmentIds.has(input.treatmentId)) {
      return {
        ok: false,
        reason: `unknown treatmentId "${input.treatmentId}"; choose from: ${[...treatmentIds].join(', ')}`,
      };
    }
    if (input.paletteId) {
      const paletteIds = new Set(catalog.palettes.map(p => p.id));
      if (!paletteIds.has(input.paletteId)) {
        return { ok: false, reason: `unknown paletteId "${input.paletteId}"` };
      }
    }
    if (input.fontPairingId) {
      const pairingIds = new Set(catalog.pairings.map(p => p.id));
      if (!pairingIds.has(input.fontPairingId)) {
        return { ok: false, reason: `unknown fontPairingId "${input.fontPairingId}"` };
      }
    }
    return { ok: true };
  },

  async run(input) {
    const store = new ThemeDecisionStore();
    store.set({
      bundleId: input.bundle.id,
      treatmentId: input.treatmentId,
      paletteId: input.paletteId,
      fontPairingId: input.fontPairingId,
      source: 'agent',
      decidedAt: new Date().toISOString(),
      decidedBy: input.decidedBy,
    });
    return { bundleId: input.bundle.id, treatmentId: input.treatmentId, source: 'agent' };
  },
};
