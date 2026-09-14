export const DEFAULT_OPENCODE_MODELS = [
  'opencode-go/gpt-5.4',
  'opencode-go/deepseek-v4-pro',
  'opencode-go/qwen3.7-max',
];

export function modelOptionsWithCurrent(models: string[], currentModel: string) {
  const options = models.length > 0 ? models : DEFAULT_OPENCODE_MODELS;
  if (!currentModel || options.includes(currentModel)) return options;
  return [currentModel, ...options];
}
