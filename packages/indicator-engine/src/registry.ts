import type { IndicatorConfig, IndicatorDefinition } from './types';

export class IndicatorRegistry {
  private readonly definitions = new Map<string, IndicatorDefinition>();
  register(definition: IndicatorDefinition): () => void {
    if (!definition.type || this.definitions.has(definition.type))
      throw new Error(`Indicator already registered: ${definition.type}`);
    this.definitions.set(definition.type, definition);
    return () => {
      if (this.definitions.get(definition.type) === definition)
        this.definitions.delete(definition.type);
    };
  }
  get(type: string): IndicatorDefinition {
    const definition = this.definitions.get(type);
    if (!definition) throw new Error(`Unknown indicator: ${type}`);
    return definition;
  }
  list(): IndicatorDefinition[] {
    return [...this.definitions.values()];
  }
  normalize(config: IndicatorConfig): IndicatorConfig {
    const definition = this.get(config.type);
    const params: Record<string, number> = {};
    for (const [key, rule] of Object.entries(definition.parameters)) {
      const value = config.params[key] ?? rule.default;
      if (
        !Number.isFinite(value) ||
        value < rule.min ||
        value > rule.max ||
        (rule.integer && !Number.isInteger(value))
      ) {
        throw new Error(
          `${config.type}.${key} must be ${rule.integer ? 'an integer ' : ''}between ${rule.min} and ${rule.max}`,
        );
      }
      params[key] = value;
    }
    if (config.type === 'MACD' && params.fast >= params.slow)
      throw new Error('MACD fast period must be smaller than slow period');
    return { ...config, params, pane: definition.outputs.length ? config.pane : 'price' };
  }
}
