import { z } from "zod";

export const translationBatchItemSchema = z.object({
  key: z.string().trim().min(1),
  sourceText: z.string(),
  sourceLanguage: z.string().trim().min(1).optional(),
});

export type TranslationBatchItem = z.infer<typeof translationBatchItemSchema>;

export const translationProviderVersionSchema = z.object({
  provider: z.string().trim().min(1),
  apiVersion: z.string().trim().min(1),
  policyVersion: z.string().trim().min(1),
});

export type TranslationProviderVersion = z.infer<typeof translationProviderVersionSchema>;

export const translationResultItemSchema = z.object({
  key: z.string().trim().min(1),
  sourceText: z.string(),
  translatedText: z.string(),
  targetLanguage: z.string().trim().min(1),
  sourceLanguage: z.string().trim().min(1).optional(),
  detectedSourceLanguage: z.string().trim().min(1).optional(),
});

export type TranslationResultItem = z.infer<typeof translationResultItemSchema>;

export const translationBatchResultSchema = z.object({
  providerVersion: translationProviderVersionSchema,
  items: z.array(translationResultItemSchema),
});

export type TranslationBatchResult = z.infer<typeof translationBatchResultSchema>;

export interface TranslationProvider {
  readonly providerVersion: TranslationProviderVersion;
  translateBatch(
    items: readonly TranslationBatchItem[],
    targetLanguage: string,
  ): Promise<TranslationBatchResult>;
}
