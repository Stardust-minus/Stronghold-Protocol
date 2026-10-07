// Counterfactual upstream 0.2.0 leader rules, not this fork's live alive/4 configuration.
export function officialBossData(data) {
  return {
    ...data,
    config: {
      ...data.config,
      bossHpScale: { ...data.config.bossHpScale, perPlayer: true, coop: 1, solo: 1, aliveScaling: false },
      modes: Object.fromEntries(Object.entries(data.config.modes).map(([id, mode]) => [id, {
        ...mode,
        bossHpScale: {
          bloodPointKey: mode.bossHpScale?.bloodPointKey ?? null,
          unaffectedByEnemyScale: mode.bossHpScale?.unaffectedByEnemyScale ?? true,
        },
      }])),
    },
  };
}
