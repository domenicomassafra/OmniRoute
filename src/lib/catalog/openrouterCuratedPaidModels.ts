import { z } from "zod";

const OPENROUTER_MODEL_DETAIL_BASE_URL = "https://openrouter.ai/api/v1/model";

export const OPENROUTER_CURATED_PAID_POINT_MODEL_IDS = ["~typesafe/jev-latest"] as const;
const OPENROUTER_CURATED_PAID_POINT_MODEL_ID_SET = new Set<string>(
  OPENROUTER_CURATED_PAID_POINT_MODEL_IDS
);

export type OpenRouterCatalogModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
    request?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    instruct_type?: string | null;
  };
  supported_parameters?: string[];
  created?: number;
  [key: string]: unknown;
};

const pointModelSchema = z.object({ id: z.string().min(1) }).passthrough();

export function buildOpenRouterPointModelUrl(modelId: string): string {
  const separator = modelId.indexOf("/");
  if (separator <= 0 || separator === modelId.length - 1) {
    throw new Error(`Invalid OpenRouter point-model id: ${modelId}`);
  }
  const author = modelId.slice(0, separator);
  const slug = modelId.slice(separator + 1);
  return `${OPENROUTER_MODEL_DETAIL_BASE_URL}/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;
}

function parsePointModel(payload: unknown, expectedId: string): OpenRouterCatalogModel | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = (payload as Record<string, unknown>).data;
  const parsed = pointModelSchema.safeParse(data);
  if (!parsed.success || parsed.data.id !== expectedId) return null;
  return parsed.data as OpenRouterCatalogModel;
}

export function isOpenRouterCuratedPaidPointModelId(modelId: unknown): modelId is string {
  return typeof modelId === "string" && OPENROUTER_CURATED_PAID_POINT_MODEL_ID_SET.has(modelId);
}

/**
 * Keep the normal free-only decision intact while admitting the tiny,
 * explicitly-curated OpenRouter paid exception set during model sync.
 */
export function mergeOpenRouterCuratedPaidModelsIntoImport<T extends { id?: string }>(
  selectedModels: readonly T[],
  allFetchedModels: readonly T[]
): T[] {
  const merged = [...selectedModels];
  const seen = new Set(merged.map((model) => model.id).filter((id): id is string => Boolean(id)));
  for (const model of allFetchedModels) {
    if (!isOpenRouterCuratedPaidPointModelId(model.id) || seen.has(model.id)) continue;
    merged.push(model);
    seen.add(model.id);
  }
  return merged;
}

/**
 * OpenRouter's bulk `/api/v1/models` catalog omits a small class of paid alias/router
 * models. Point-discover only the explicitly curated IDs that are missing from the bulk
 * response. Failures are best-effort: a missing point model must never discard an otherwise
 * healthy bulk catalog.
 */
export async function enrichOpenRouterCatalogWithCuratedPaidPointModels(
  models: readonly OpenRouterCatalogModel[],
  fetchPointModel: (url: string, modelId: string) => Promise<unknown>
): Promise<OpenRouterCatalogModel[]> {
  const merged = [...models];
  const seen = new Set(
    models
      .map((model) => (typeof model?.id === "string" ? model.id : ""))
      .filter((id) => id.length > 0)
  );

  for (const modelId of OPENROUTER_CURATED_PAID_POINT_MODEL_IDS) {
    if (seen.has(modelId)) continue;
    try {
      const payload = await fetchPointModel(buildOpenRouterPointModelUrl(modelId), modelId);
      const model = parsePointModel(payload, modelId);
      if (!model) continue;
      merged.push(model);
      seen.add(modelId);
    } catch {
      // Best-effort enrichment only; preserve the successful bulk catalog.
    }
  }

  return merged;
}
