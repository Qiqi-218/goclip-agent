/** Plugin configuration. Secrets are referenced through environment-variable names. */
import z from '@deepseek-ai/schemastery'

/** Storage, model and OSS settings for the native video tools. */
export interface Config {
  dataDir: string
  modelBaseUrl: string
  model: string
  apiKeyEnv: string
  ossEndpoint: string
  ossBucket: string
  ossAccessKeyIdEnv: string
  ossAccessKeySecretEnv: string
  ossPrefix: string
  ossOutputPrefix: string
  ossProjectPrefix: string
  signedUrlSeconds: number
}

/** Cordis schema for {@link Config}. */
export const Config: z<Config> = z.object({
  dataDir: z.string().required(),
  modelBaseUrl: z.string().required(),
  model: z.string().required(),
  apiKeyEnv: z.string().required(),
  ossEndpoint: z.string().required(),
  ossBucket: z.string().required(),
  ossAccessKeyIdEnv: z.string().required(),
  ossAccessKeySecretEnv: z.string().required(),
  ossPrefix: z.string().required(),
  ossOutputPrefix: z.string().required(),
  ossProjectPrefix: z.string().required(),
  signedUrlSeconds: z.number().required(),
})
