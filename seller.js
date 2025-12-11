// seller.js — DeFi Yield Optimizer Provider (V2 ACP client, rich deliverables)
require('dotenv').config();

const AcpClientModule = require('@virtuals-protocol/acp-node');
const AcpClient = AcpClientModule.default;
const { AcpContractClientV2 } = AcpClientModule;

// In-memory cache for job metadata between phase 1 and phase 3
const jobMetadata = new Map();

// ---------- Small helper utilities ----------

function nowIso() {
  return new Date().toISOString();
}

function ensureString(v) {
  return typeof v === 'string';
}

function ensureNumber(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

function ensureBoolean(v) {
  return typeof v === 'boolean';
}

function ensureArray(v) {
  return Array.isArray(v);
}

function validationError(message, field) {
  return { message, field };
}

// DeFi-ish helpers (no on-chain calls, just heuristics)

function classifyAsset(symbol) {
  const s = (symbol || '').toUpperCase();
  if (['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD'].includes(s)) {
    return 'stablecoin';
  }
  if (['ETH', 'WETH', 'WBTC'].includes(s)) {
    return 'bluechip';
  }
  if (s.includes('-LP') || s.includes('/')) {
    return 'lp_token';
  }
  return 'long_tail';
}

function chainRiskFactor(chain) {
  const c = (chain || '').toLowerCase();
  if (c.includes('mainnet') || c === 'ethereum') return 0.8; // safer
  if (c.includes('base') || c.includes('arbitrum') || c.includes('optimism')) return 1.0;
  return 1.2; // unknown / higher beta
}

function riskToleranceBias(riskTolerance) {
  switch (riskTolerance) {
    case 'conservative':
      return { apyBoost: -3, riskBoost: -15 };
    case 'balanced':
      return { apyBoost: 0, riskBoost: 0 };
    case 'aggressive':
      return { apyBoost: +5, riskBoost: +10 };
    default:
      return { apyBoost: 0, riskBoost: 0 };
  }
}

// ---------- JOB 1: yield_scan_and_ranking ----------

function validateYieldScan(input) {
  const errors = [];

  if (!ensureString(input.client_agent_id)) {
    errors.push(
      validationError('client_agent_id must be string', 'client_agent_id')
    );
  }

  if (!ensureString(input.chain)) {
    errors.push(validationError('chain must be string', 'chain'));
  }

  if (!ensureArray(input.assets)) {
    errors.push(
      validationError('assets must be array of strings', 'assets')
    );
  } else if (!input.assets.every(ensureString)) {
    errors.push(
      validationError('assets items must be strings', 'assets')
    );
  }

  if (!ensureString(input.risk_tolerance)) {
    errors.push(
      validationError('risk_tolerance must be string', 'risk_tolerance')
    );
  }

  if (!ensureNumber(input.min_tvl_usd)) {
    errors.push(
      validationError('min_tvl_usd must be number', 'min_tvl_usd')
    );
  }

  if (!ensureNumber(input.lookback_hours)) {
    errors.push(
      validationError('lookback_hours must be number', 'lookback_hours')
    );
  }

  return errors;
}

function handleYieldScan(input) {
  const errors = validateYieldScan(input);
  const valid = errors.length === 0;

  const chain = input.chain || 'unknown';
  const assets = Array.isArray(input.assets) ? input.assets : [];
  const minTvl = input.min_tvl_usd || 0;
  const lookback = input.lookback_hours || 24;
  const rt = input.risk_tolerance || 'balanced';

  const bias = riskToleranceBias(rt);
  const chainRisk = chainRiskFactor(chain);

  const opportunities = [];

  assets.forEach((assetSymbol) => {
    const assetType = classifyAsset(assetSymbol);

    // Base APY bands by asset type
    let baseLowRiskApy;
    let baseMediumRiskApy;
    let baseHighRiskApy;
    switch (assetType) {
      case 'stablecoin':
        baseLowRiskApy = 3;
        baseMediumRiskApy = 6;
        baseHighRiskApy = 12;
        break;
      case 'bluechip':
        baseLowRiskApy = 4;
        baseMediumRiskApy = 10;
        baseHighRiskApy = 20;
        break;
      case 'lp_token':
        baseLowRiskApy = 8;
        baseMediumRiskApy = 20;
        baseHighRiskApy = 45;
        break;
      case 'long_tail':
      default:
        baseLowRiskApy = 6;
        baseMediumRiskApy = 18;
        baseHighRiskApy = 60;
        break;
    }

    const tvlFloor = Math.max(minTvl, 50_000);
    const tvlMid = tvlFloor * 5;
    const tvlHigh = tvlFloor * 25;

    function buildRiskScore(level, tvl) {
      let score;
      if (level === 'low') score = 20;
      else if (level === 'medium') score = 45;
      else score = 70;

      // Higher TVL → slightly lower risk
      if (tvl >= tvlHigh) score -= 5;
      else if (tvl >= tvlMid) score -= 2;

      // Chain factor nudges risk upward if riskier
      score *= chainRisk;

      return Math.max(5, Math.min(95, Math.round(score)));
    }

    function buildRiskBreakdown(level, tvl, assetTypeInner) {
      const base = {
        smart_contract_risk: 0,
        liquidity_risk: 0,
        depeg_risk: 0,
        impermanent_loss_risk: 0
      };

      if (level === 'low') {
        base.smart_contract_risk = 15;
        base.liquidity_risk = tvlHigh <= tvl ? 10 : 20;
      } else if (level === 'medium') {
        base.smart_contract_risk = 30;
        base.liquidity_risk = tvlHigh <= tvl ? 20 : 35;
      } else {
        base.smart_contract_risk = 45;
        base.liquidity_risk = tvlHigh <= tvl ? 30 : 45;
      }

      if (assetTypeInner === 'stablecoin') {
        base.depeg_risk = level === 'low' ? 5 : level === 'medium' ? 15 : 25;
      } else if (assetTypeInner === 'lp_token') {
        base.impermanent_loss_risk = level === 'low' ? 20 : level === 'medium' ? 35 : 50;
      } else if (assetTypeInner === 'long_tail') {
        base.depeg_risk = level === 'low' ? 10 : level === 'medium' ? 25 : 40;
      }

      return base;
    }

    const variants = [
      {
        level: 'low',
        protocol: 'SafeLend',
        description: 'Conservative lending / borrowing market on battle-tested lending protocol.',
        apyBase: baseLowRiskApy,
        tvl: tvlHigh,
        venue_type: 'lending'
      },
      {
        level: 'medium',
        protocol: 'YieldDex',
        description: 'DEX pool or boosted lending vault with moderate incentives.',
        apyBase: baseMediumRiskApy,
        tvl: tvlMid,
        venue_type: assetType === 'lp_token' ? 'lp' : 'dex_pool'
      },
      {
        level: 'high',
        protocol: 'DeFiTurbo',
        description:
          'High-incentive farm with non-trivial smart-contract and liquidity risk. For degen bucket only.',
        apyBase: baseHighRiskApy,
        tvl: tvlFloor,
        venue_type: 'structured_farm'
      }
    ];

    variants.forEach((v) => {
      const estApy = Math.max(
        0.1,
        Math.round((v.apyBase + bias.apyBoost) * 10) / 10
      );
      const riskScore = buildRiskScore(v.level, v.tvl) + bias.riskBoost;
      const finalRiskScore = Math.max(5, Math.min(95, Math.round(riskScore)));

      opportunities.push({
        protocol: v.protocol,
        pool_address: `0x${v.protocol.slice(0, 6)}${assetSymbol.slice(0, 4)}Pool...`,
        chain,
        asset: assetSymbol,
        asset_type: assetType,
        venue_type: v.venue_type,
        risk_band: v.level,
        estimated_apy: estApy,
        tvl_usd: v.tvl,
        risk_score: finalRiskScore,
        risk_breakdown: buildRiskBreakdown(v.level, v.tvl, assetType),
        lookback_hours_used: lookback,
        qualitative_summary: v.description,
        fit_explanation: (() => {
          if (rt === 'conservative') {
            if (v.level === 'low') {
              return 'Aligned with conservative profile; focus on principal preservation and sustainable yield.';
            }
            if (v.level === 'medium') {
              return 'Borderline fit; could be used as a small satellite allocation if capital is segmented.';
            }
            return 'Not recommended for conservative profile; risk / reward skew is too aggressive.';
          }
          if (rt === 'aggressive') {
            if (v.level === 'high') {
              return 'Good fit for degen bucket with tight risk monitoring and sizing discipline.';
            }
            return 'Core position candidate to anchor portfolio while keeping optionality for higher-risk legs.';
          }
          return 'Candidate venue for balanced risk; size within overall risk budget and ensure monitoring alerts.';
        })()
      });
    });
  });

  // Rank by "utility" depending on risk_tolerance
  const utilitySorted = [...opportunities].sort((a, b) => {
    const aUtil =
      (rt === 'conservative'
        ? a.estimated_apy - a.risk_score * 0.2
        : rt === 'aggressive'
        ? a.estimated_apy * 1.3 - a.risk_score * 0.1
        : a.estimated_apy - a.risk_score * 0.15);
    const bUtil =
      (rt === 'conservative'
        ? b.estimated_apy - b.risk_score * 0.2
        : rt === 'aggressive'
        ? b.estimated_apy * 1.3 - b.risk_score * 0.1
        : b.estimated_apy - b.estimated_apy * 0.15);
    return bUtil - aUtil;
  });

  const bestLowRisk = utilitySorted.find((o) => o.risk_band === 'low');
  const bestMaxApy = [...utilitySorted].sort(
    (a, b) => b.estimated_apy - a.estimated_apy
  )[0];

  const portfolioHints = {
    core_yield_candidate: bestLowRisk || null,
    max_apy_candidate: bestMaxApy || null,
    diversification_comment:
      opportunities.length > 0
        ? 'Mix 1–2 core venues (low/medium risk) with tightly sized exposure to a single high-risk farm if your mandate allows.'
        : 'No venues constructed; check input assets / parameters.'
  };

  return {
    job_name: 'yield_scan_and_ranking',
    chain,
    assets,
    timestamp_utc: nowIso(),
    risk_tolerance: rt,
    min_tvl_usd_applied: minTvl,
    opportunities_ranked: utilitySorted,
    portfolio_hints: portfolioHints,
    validation_passed: valid,
    validation_errors: errors
  };
}

// ---------- JOB 2: portfolio_yield_allocation_plan ----------

function validatePortfolioPlan(input) {
  const errors = [];
  if (!ensureString(input.client_agent_id)) {
    errors.push(validationError('client_agent_id must be string', 'client_agent_id'));
  }
  if (!ensureString(input.chain)) {
    errors.push(validationError('chain must be string', 'chain'));
  }
  if (!ensureNumber(input.starting_capital_usd)) {
    errors.push(validationError('starting_capital_usd must be number', 'starting_capital_usd'));
  }
  if (!ensureString(input.risk_tolerance)) {
    errors.push(validationError('risk_tolerance must be string', 'risk_tolerance'));
  }
  if (!ensureNumber(input.target_horizon_days)) {
    errors.push(validationError('target_horizon_days must be number', 'target_horizon_days'));
  }
  if (typeof input.preferences !== 'object' || input.preferences === null) {
    errors.push(validationError('preferences must be object', 'preferences'));
  } else {
    const p = input.preferences;
    if (!ensureBoolean(p.allow_leverage)) {
      errors.push(
        validationError('preferences.allow_leverage must be boolean', 'preferences.allow_leverage')
      );
    }
    if (!ensureBoolean(p.allow_lockups)) {
      errors.push(
        validationError('preferences.allow_lockups must be boolean', 'preferences.allow_lockups')
      );
    }
    if (!ensureNumber(p.max_positions)) {
      errors.push(
        validationError('preferences.max_positions must be number', 'preferences.max_positions')
      );
    }
  }
  return errors;
}

function handlePortfolioPlan(input) {
  const errors = validatePortfolioPlan(input);
  const valid = errors.length === 0;

  const capital = input.starting_capital_usd || 0;
  const chain = input.chain || 'unknown';
  const rt = input.risk_tolerance || 'balanced';
  const horizonDays = input.target_horizon_days || 30;
  const prefs = input.preferences || {
    allow_leverage: false,
    allow_lockups: false,
    max_positions: 3
  };

  // Define buckets: core, satellite, experimental
  let coreWeight, satelliteWeight, experimentalWeight;
  if (rt === 'conservative') {
    coreWeight = 0.75;
    satelliteWeight = 0.2;
    experimentalWeight = 0.05;
  } else if (rt === 'aggressive') {
    coreWeight = 0.4;
    satelliteWeight = 0.35;
    experimentalWeight = 0.25;
  } else {
    coreWeight = 0.6;
    satelliteWeight = 0.25;
    experimentalWeight = 0.15;
  }

  if (!prefs.allow_lockups) {
    // Reduce experimental bucket if lockups are disallowed
    experimentalWeight *= 0.5;
    const deficit = 0.25 * experimentalWeight;
    coreWeight += deficit;
    satelliteWeight += deficit;
  }

  // Normalize just in case
  const totalWeight = coreWeight + satelliteWeight + experimentalWeight || 1;
  coreWeight /= totalWeight;
  satelliteWeight /= totalWeight;
  experimentalWeight /= totalWeight;

  const maxPositions = Math.max(1, Math.round(prefs.max_positions));
  const chainRisk = chainRiskFactor(chain);

  function buildBucketAlloc(name, weight, archetype) {
    const allocUsd = capital * weight;
    if (allocUsd <= 0) return null;

    let estApyMid;
    let riskScore;
    if (archetype === 'core') {
      estApyMid = rt === 'aggressive' ? 8 : rt === 'conservative' ? 4 : 6;
      riskScore = 25 * chainRisk;
    } else if (archetype === 'satellite') {
      estApyMid = rt === 'aggressive' ? 18 : 12;
      riskScore = 45 * chainRisk;
    } else {
      estApyMid = rt === 'aggressive' ? 35 : 25;
      riskScore = 70 * chainRisk;
    }

    const estApyLow = estApyMid * 0.6;
    const estApyHigh = estApyMid * 1.4;

    return {
      bucket_name: name,
      archetype,
      allocation_usd: Math.round(allocUsd * 100) / 100,
      allocation_percent: Math.round(weight * 1000) / 10,
      expected_apy_range_pct: {
        low: Math.round(estApyLow * 10) / 10,
        mid: Math.round(estApyMid * 10) / 10,
        high: Math.round(estApyHigh * 10) / 10
      },
      risk_score: Math.round(Math.min(95, riskScore)),
      example_instruments:
        archetype === 'core'
          ? ['Blue-chip stablecoin lending on battle-tested protocol']
          : archetype === 'satellite'
          ? ['ETH or blue-chip perp / vault', 'LP in large-cap DEX pool']
          : ['Long-tail farm with capped sizing', 'High incentive LP with strict stop-loss rules'],
      guardrails: (() => {
        if (archetype === 'core') {
          return [
            'No leverage or only mild leverage (<= 1.3x) if explicitly allowed.',
            'Liquidity depth / TVL must be above internal threshold.',
            'Protocol must have public audits or strong battle-tested history.'
          ];
        }
        if (archetype === 'satellite') {
          return [
            'Size each position so that a total loss does not break portfolio risk budget.',
            'Require on-chain activity / volume above minimal threshold.',
            'Monitor funding / rewards for sudden cliffs.'
          ];
        }
        return [
          'Treat as “degen bucket”; assume potential near-total loss.',
          'Isolate in separate address / sub-account where possible.',
          'Explicitly tag these positions for elevated monitoring frequency.'
        ];
      })()
    };
  }

  const bucketsRaw = [
    buildBucketAlloc('Core yield (principal preservation focus)', coreWeight, 'core'),
    buildBucketAlloc('Satellite directional yield', satelliteWeight, 'satellite'),
    buildBucketAlloc('Experimental / degen bucket', experimentalWeight, 'experimental')
  ].filter(Boolean);

  // Flatten into up to max_positions "slots"
  const allocations = [];
  bucketsRaw.forEach((bucket) => {
    const splits = Math.max(1, Math.min(maxPositions, 2));
    const perSlotUsd = bucket.allocation_usd / splits;
    for (let i = 0; i < splits; i++) {
      allocations.push({
        protocol_hint:
          bucket.archetype === 'core'
            ? 'SafeLend (stablecoin lending)'
            : bucket.archetype === 'satellite'
            ? 'YieldDex (blue-chip LP / vault)'
            : 'DeFiTurbo (high-incentive farm)',
        chain,
        asset_hint:
          bucket.archetype === 'core'
            ? 'USDC / USDT'
            : bucket.archetype === 'satellite'
            ? 'WETH / ETH-USD LP'
            : 'volatile / long-tail token or LP',
        bucket_name: bucket.bucket_name,
        archetype: bucket.archetype,
        allocation_usd: Math.round(perSlotUsd * 100) / 100,
        allocation_percent_of_portfolio: Math.round(
          (perSlotUsd / capital) * 1000
        ) / 10,
        expected_apy_range_pct: bucket.expected_apy_range_pct,
        risk_score: bucket.risk_score,
        guardrails: bucket.guardrails
      });
    }
  });

  const estimatedPortfolioApyMid = (() => {
    if (capital <= 0) return 0;
    return (
      bucketsRaw.reduce(
        (acc, b) => acc + b.expected_apy_range_pct.mid * (b.allocation_usd / capital),
        0
      ) || 0
    );
  })();

  const estimatedRiskScore = (() => {
    if (!bucketsRaw.length) return 50;
    return Math.round(
      bucketsRaw.reduce(
        (acc, b) => acc + b.risk_score * (b.allocation_usd / capital),
        0
      )
    );
  })();

  const rebalancing = {
    suggested_frequency_days:
      horizonDays <= 30 ? 7 : horizonDays <= 90 ? 14 : 30,
    triggers: [
      'Any position exceeding its maximum allowed weight by >25%.',
      'Sharp change in yield profile (>50% APY change in short window).',
      'Material protocol risk event (exploit, governance drama, depeg).'
    ]
  };

  const scenarioAnalysis = {
    horizon_days: horizonDays,
    bear_case_return_pct: Math.round((estimatedPortfolioApyMid * 0.2) * (horizonDays / 365)),
    base_case_return_pct: Math.round((estimatedPortfolioApyMid * 0.8) * (horizonDays / 365)),
    bull_case_return_pct: Math.round((estimatedPortfolioApyMid * 1.6) * (horizonDays / 365)),
    commentary:
      'Returns are expressed as non-annualized estimates over the provided horizon, based on synthetic APY assumptions. Use as planning guidance only.'
  };

  return {
    job_name: 'portfolio_yield_allocation_plan',
    chain,
    starting_capital_usd: capital,
    risk_tolerance: rt,
    preferences_applied: prefs,
    timestamp_utc: nowIso(),
    estimated_portfolio_apy_mid_pct: Math.round(estimatedPortfolioApyMid * 10) / 10,
    estimated_portfolio_risk_score: estimatedRiskScore,
    buckets_view: bucketsRaw,
    position_allocations_view: allocations.slice(0, maxPositions),
    rebalancing_policy: rebalancing,
    scenario_analysis: scenarioAnalysis,
    validation_passed: valid,
    validation_errors: errors
  };
}

// ---------- JOB 3: execution_bundle_builder ----------

function validateExecutionBundle(input) {
  const errors = [];
  if (!ensureString(input.client_agent_id)) {
    errors.push(validationError('client_agent_id must be string', 'client_agent_id'));
  }
  if (!ensureString(input.chain)) {
    errors.push(validationError('chain must be string', 'chain'));
  }
  if (!ensureArray(input.desired_allocations)) {
    errors.push(validationError('desired_allocations must be array', 'desired_allocations'));
  } else {
    input.desired_allocations.forEach((item, idx) => {
      if (!ensureString(item.asset_in)) {
        errors.push(validationError(
          `desired_allocations[${idx}].asset_in must be string`,
          `desired_allocations.${idx}.asset_in`
        ));
      }
      if (!ensureString(item.asset_out)) {
        errors.push(validationError(
          `desired_allocations[${idx}].asset_out must be string`,
          `desired_allocations.${idx}.asset_out`
        ));
      }
      if (!ensureNumber(item.amount_in)) {
        errors.push(validationError(
          `desired_allocations[${idx}].amount_in must be number`,
          `desired_allocations.${idx}.amount_in`
        ));
      }
      if (!ensureString(item.venue)) {
        errors.push(validationError(
          `desired_allocations[${idx}].venue must be string`,
          `desired_allocations.${idx}.venue`
        ));
      }
    });
  }

  // Optional global knobs; only type-check if present
  if (input.slippage_bps !== undefined && !ensureNumber(input.slippage_bps)) {
    errors.push(validationError('slippage_bps must be number when provided', 'slippage_bps'));
  }
  if (input.deadline_seconds !== undefined && !ensureNumber(input.deadline_seconds)) {
    errors.push(
      validationError('deadline_seconds must be number when provided', 'deadline_seconds')
    );
  }
  if (input.prefer_batching !== undefined && !ensureBoolean(input.prefer_batching)) {
    errors.push(
      validationError('prefer_batching must be boolean when provided', 'prefer_batching')
    );
  }

  return errors;
}

function handleExecutionBundle(input) {
  const errors = validateExecutionBundle(input);
  const valid = errors.length === 0;

  const chain = input.chain || 'unknown';
  const bundleId = `bundle_${chain}_${Date.now()}`;

  // Use provided values if present, otherwise default
  const slippageBps = input.slippage_bps ?? 50;
  const deadlineSeconds = input.deadline_seconds ?? 900;
  const preferBatching =
    typeof input.prefer_batching === 'boolean' ? input.prefer_batching : true;

  function inferActionType(alloc) {
    const venue = alloc.venue.toLowerCase();
    const out = alloc.asset_out.toUpperCase();
    if (venue.includes('lend') || venue.includes('aave') || venue.includes('compound')) {
      return 'supply_or_borrow';
    }
    if (venue.includes('lp') || out.includes('-LP') || out.includes('/')) {
      return 'add_liquidity';
    }
    if (venue.includes('vault') || venue.includes('farm')) {
      return 'vault_deposit';
    }
    return 'swap';
  }

  const txs = (input.desired_allocations || []).map((alloc, idx) => {
    const actionType = inferActionType(alloc);
    const sizeCategory =
      alloc.amount_in < 1_000
        ? 'small'
        : alloc.amount_in < 100_000
        ? 'medium'
        : 'large';
    const priceImpactHint =
      sizeCategory === 'small'
        ? 'expected_low'
        : sizeCategory === 'medium'
        ? 'monitor'
        : 'high_attention';

    return {
      index: idx,
      description: `Execute ${actionType} from ${alloc.asset_in} → ${alloc.asset_out} on ${alloc.venue}`,
      action_type: actionType,
      to: `0xRouterOrProtocol${idx.toString().padStart(2, '0')}...`,
      data: `0x${(1000 + idx).toString(16)}deadbeef`,
      value: '0',
      gas_limit_hint: actionType === 'swap' ? 220000 : 350000,
      meta: {
        chain,
        venue: alloc.venue,
        asset_in: alloc.asset_in,
        asset_out: alloc.asset_out,
        notional_estimate_usd: alloc.amount_in,
        size_category: sizeCategory,
        price_impact_hint: priceImpactHint,
        slippage_bps: slippageBps,
        deadline_seconds: deadlineSeconds
      }
    };
  });

  const estimatedGasUsd = Math.round(txs.length * 1.75 * 100) / 100;

  const operational_risks = [
    'Route selection is synthetic; validate routers and paths before signing.',
    'Ensure slippage and deadlines are aligned with current liquidity conditions.',
    'Run a dry-run / simulation on test environment if changing venues or assets.'
  ];

  const batchingPlan = preferBatching
    ? {
        strategy: 'batch_by_venue',
        rationale:
          'Group interactions per venue to reduce overhead and limit nonce management complexity.',
        tentative_batches: txs.reduce((acc, tx) => {
          const venue = tx.meta.venue;
          if (!acc[venue]) acc[venue] = [];
          acc[venue].push(tx.index);
          return acc;
        }, {})
      }
    : {
        strategy: 'sequential_execution',
        rationale:
          'Execute in deterministic order for simpler monitoring and rollback reasoning.'
      };

  return {
    job_name: 'execution_bundle_builder',
    chain,
    timestamp_utc: nowIso(),
    bundle_id: bundleId,
    slippage_bps_applied: slippageBps,
    deadline_seconds_applied: deadlineSeconds,
    prefer_batching: preferBatching,
    estimated_gas_cost_usd: estimatedGasUsd,
    txs,
    batching_plan: batchingPlan,
    operational_risks,
    validation_passed: valid,
    validation_errors: errors
  };
}

// ---------- JOB 4: position_health_monitor ----------

function validatePositionHealth(input) {
  const errors = [];
  if (!ensureString(input.client_agent_id)) {
    errors.push(validationError('client_agent_id must be string', 'client_agent_id'));
  }
  if (!ensureString(input.chain)) {
    errors.push(validationError('chain must be string', 'chain'));
  }
  if (!ensureArray(input.positions)) {
    errors.push(validationError('positions must be array', 'positions'));
  } else {
    input.positions.forEach((pos, idx) => {
      if (!ensureString(pos.protocol)) {
        errors.push(validationError(
          `positions[${idx}].protocol must be string`,
          `positions.${idx}.protocol`
        ));
      }
      if (!ensureString(pos.pool_address)) {
        errors.push(validationError(
          `positions[${idx}].pool_address must be string`,
          `positions.${idx}.pool_address`
        ));
      }
      if (!ensureString(pos.position_id)) {
        errors.push(validationError(
          `positions[${idx}].position_id must be string`,
          `positions.${idx}.position_id`
        ));
      }
      if (!ensureNumber(pos.health_threshold)) {
        errors.push(validationError(
          `positions[${idx}].health_threshold must be number`,
          `positions.${idx}.health_threshold`
        ));
      }
    });
  }
  if (!ensureString(input.notify_channel)) {
    errors.push(validationError('notify_channel must be string', 'notify_channel'));
  }
  if (!ensureNumber(input.check_frequency_minutes)) {
    errors.push(
      validationError('check_frequency_minutes must be number', 'check_frequency_minutes')
    );
  }
  return errors;
}

function handlePositionHealth(input) {
  const errors = validatePositionHealth(input);
  const valid = errors.length === 0;

  const chain = input.chain || 'unknown';
  const positions = input.positions || [];
  const checkFreq = input.check_frequency_minutes || 15;

  const snapshots = positions.map((pos) => {
    const threshold = pos.health_threshold;
    const baseHealth = threshold >= 80 ? 72 : threshold >= 60 ? 78 : 85;
    const liquidationBufferPct =
      baseHealth >= 80 ? 30 : baseHealth >= 70 ? 20 : 10;

    const breach = baseHealth < threshold;

    const severity =
      baseHealth >= threshold + 10
        ? 'info'
        : baseHealth >= threshold
        ? 'watch'
        : baseHealth >= threshold - 10
        ? 'warning'
        : 'critical';

    const issues = [];
    const recommendedActions = [];

    if (breach) {
      issues.push('Synthetic breach: health score below configured threshold.');
      recommendedActions.push(
        'Evaluate options: partial deleveraging, collateral top-up, or closing position.'
      );
    } else if (severity === 'warning') {
      issues.push('Health score is within 10 points of threshold; risk is non-trivial.');
      recommendedActions.push(
        'Increase monitoring frequency and pre-plan deleveraging triggers.'
      );
    } else if (severity === 'watch') {
      issues.push('Health score only slightly above threshold.');
      recommendedActions.push(
        'Define automated alert if health score drops by additional 5–10 points.'
      );
    } else {
      recommendedActions.push(
        'No immediate action suggested; maintain baseline monitoring.'
      );
    }

    recommendedActions.push(
      'If using perps/options elsewhere, tag this position as reference and consider offsetting directional risk.'
    );

    return {
      protocol: pos.protocol,
      pool_address: pos.pool_address,
      position_id: pos.position_id,
      chain,
      synthetic_health_score: baseHealth,
      configured_health_threshold: threshold,
      liquidation_buffer_pct: liquidationBufferPct,
      breach,
      severity,
      issues,
      recommended_actions: recommendedActions
    };
  });

  const totalPositions = snapshots.length;
  const breachedCount = snapshots.filter((s) => s.breach).length;
  const nearThresholdCount = snapshots.filter(
    (s) => !s.breach && s.synthetic_health_score < s.configured_health_threshold + 5
  ).length;

  const portfolioSummary = {
    total_positions: totalPositions,
    breached_positions: breachedCount,
    near_threshold_positions: nearThresholdCount,
    monitoring_frequency_minutes: checkFreq,
    monitoring_channel: input.notify_channel,
    portfolio_risk_commentary:
      totalPositions === 0
        ? 'No positions provided; nothing to monitor.'
        : breachedCount > 0
        ? 'One or more positions are synthetically below threshold; define clear deleveraging / unwind playbook.'
        : nearThresholdCount > 0
        ? 'Some positions are hovering near risk guardrail; tighten alerting and review sizing.'
        : 'All positions have comfortable synthetic health margins given the configured thresholds.'
  };

  return {
    job_name: 'position_health_monitor',
    chain,
    timestamp_utc: nowIso(),
    positions: snapshots,
    portfolio_summary: portfolioSummary,
    validation_passed: valid,
    validation_errors: errors
  };
}

// ---------- JOB 5: strategy_backtest_report ----------

function validateBacktest(input) {
  const errors = [];
  if (!ensureString(input.client_agent_id)) {
    errors.push(validationError('client_agent_id must be string', 'client_agent_id'));
  }
  if (!ensureString(input.chain)) {
    errors.push(validationError('chain must be string', 'chain'));
  }
  if (!ensureString(input.strategy_name)) {
    errors.push(validationError('strategy_name must be string', 'strategy_name'));
  }
  if (!ensureString(input.backtest_start_utc)) {
    errors.push(validationError('backtest_start_utc must be string', 'backtest_start_utc'));
  }
  if (!ensureString(input.backtest_end_utc)) {
    errors.push(validationError('backtest_end_utc must be string', 'backtest_end_utc'));
  }
  if (!ensureNumber(input.initial_capital_usd)) {
    errors.push(validationError('initial_capital_usd must be number', 'initial_capital_usd'));
  }
  if (!ensureArray(input.simulated_actions)) {
    errors.push(
      validationError('simulated_actions must be array of strings', 'simulated_actions')
    );
  } else if (!input.simulated_actions.every(ensureString)) {
    errors.push(
      validationError('simulated_actions items must be strings', 'simulated_actions')
    );
  }
  return errors;
}

function handleBacktest(input) {
  const errors = validateBacktest(input);
  const valid = errors.length === 0;

  const chain = input.chain || 'unknown';
  const strategyName = input.strategy_name || 'unknown';
  const initialCapital = input.initial_capital_usd || 0;
  const actions = input.simulated_actions || [];

  const start = new Date(input.backtest_start_utc);
  const end = new Date(input.backtest_end_utc);
  const days =
    isNaN(start.getTime()) || isNaN(end.getTime())
      ? 30
      : Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

  const complexityFactor = Math.min(3, Math.max(0.5, actions.length / 10));
  const baseAnnualReturn =
    complexityFactor <= 0.8 ? 0.08 : complexityFactor <= 1.5 ? 0.18 : 0.3;

  const syntheticEdge =
    strategyName.toLowerCase().includes('delta-neutral') ||
    strategyName.toLowerCase().includes('market-neutral')
      ? 0.02
      : 0;
  const syntheticDrag =
    strategyName.toLowerCase().includes('degen') ||
    strategyName.toLowerCase().includes('leveraged')
      ? 0.05
      : 0;

  const netAnnualReturn = baseAnnualReturn + syntheticEdge - syntheticDrag;
  const periodReturn = netAnnualReturn * (days / 365);
  const endEquity = initialCapital * (1 + periodReturn);
  const maxDrawdownPct = Math.min(
    60,
    Math.max(8, 25 * complexityFactor + (syntheticDrag > 0 ? 10 : 0))
  );
  const volatilityPct = Math.min(
    80,
    Math.max(12, 30 * complexityFactor + (syntheticDrag > 0 ? 10 : 0))
  );

  const totalReturnPct =
    initialCapital > 0
      ? ((endEquity - initialCapital) / initialCapital) * 100
      : 0;

  const annualizedReturnPct = periodReturn * (365 / days) * 100;
  const sharpeRatioEstimate =
    volatilityPct > 0
      ? ((annualizedReturnPct - 5) / volatilityPct).toFixed(2)
      : '0.00';

  const steps = [0, 0.25, 0.5, 0.75, 1];
  const equityCurve = steps.map((f) => {
    const t = new Date(
      start.getTime() + f * (end.getTime() - start.getTime())
    ).toISOString();
    const equity = initialCapital * (1 + periodReturn * f);
    return {
      timestamp_utc: t,
      equity_usd: Math.round(equity * 100) / 100
    };
  });

  const bestDayReturnPct = (volatilityPct / 4).toFixed(2);
  const worstDayReturnPct = (-volatilityPct / 3).toFixed(2);

  const riskCommentary = [
    totalReturnPct >= 0
      ? 'Synthetic results show profitable behavior over the backtest window, but with non-trivial drawdown risk.'
      : 'Synthetic results show underperformance; consider whether the edge is structural or path-dependent.',
    `Max drawdown is modeled at ~${maxDrawdownPct.toFixed(
      1
    )}% with volatility ~${volatilityPct.toFixed(
      1
    )}%. This implies that realized PnL can deviate substantially from average return.`,
    'Use this backtest as a sanity check on position sizing and risk budget, not as a guarantee of forward returns.'
  ];

  const parameterEcho = {
    horizon_days: days,
    simulated_action_count: actions.length,
    complexity_factor_used: complexityFactor,
    assumptions: {
      base_annual_return_pct: (baseAnnualReturn * 100).toFixed(2),
      synthetic_edge_pct: (syntheticEdge * 100).toFixed(2),
      synthetic_drag_pct: (syntheticDrag * 100).toFixed(2)
    }
  };

  return {
    job_name: 'strategy_backtest_report',
    chain,
    strategy_name: strategyName,
    timestamp_utc: nowIso(),
    total_return_pct: Math.round(totalReturnPct * 10) / 10,
    annualized_return_pct: Math.round(annualizedReturnPct * 10) / 10,
    max_drawdown_pct: Math.round(maxDrawdownPct * 10) / 10,
    volatility_pct: Math.round(volatilityPct * 10) / 10,
    sharpe_ratio_estimate,
    trade_count: Math.max(1, actions.length * 3),
    best_day_return_pct,
    worst_day_return_pct,
    equity_curve,
    parameter_echo: parameterEcho,
    risk_commentary,
    key_events: [
      'Synthetic backtest: replace with real historical series when wiring to production data.',
      'No liquidation modeling included; this should be layered on top for leveraged strategies.'
    ],
    validation_passed: valid,
    validation_errors: errors
  };
}

// ---------- Job router ----------

function routeJobDeliverable(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return {
      job_name: 'unknown',
      timestamp_utc: nowIso(),
      validation_passed: false,
      validation_errors: [validationError('Missing job metadata', 'metadata')]
    };
  }

  const jobName = metadata.name;
  const requirement = metadata.requirement || {};

  switch (jobName) {
    case 'yield_scan_and_ranking':
      return handleYieldScan(requirement);
    case 'portfolio_yield_allocation_plan':
      return handlePortfolioPlan(requirement);
    case 'execution_bundle_builder':
      return handleExecutionBundle(requirement);
    case 'position_health_monitor':
      return handlePositionHealth(requirement);
    case 'strategy_backtest_report':
      return handleBacktest(requirement);
    default:
      return {
        job_name: 'unknown',
        timestamp_utc: nowIso(),
        validation_passed: false,
        validation_errors: [
          validationError(`No handler implemented for job name: ${jobName}`, 'job_name')
        ],
        message:
          'Unknown job type. Please ensure the job name matches one of the supported offerings.'
      };
  }
}

// ---------- Main ACP bootstrap (V2) ----------

async function main() {
  const privateKey = process.env.WHITELISTED_WALLET_PRIVATE_KEY;
  const sellerEntityId = process.env.SELLER_ENTITY_ID;
  const sellerWalletAddress = process.env.SELLER_AGENT_WALLET_ADDRESS;

  if (!privateKey || !sellerEntityId || !sellerWalletAddress) {
    throw new Error(
      'Missing environment variables. Check .env: WHITELISTED_WALLET_PRIVATE_KEY, SELLER_ENTITY_ID, SELLER_AGENT_WALLET_ADDRESS'
    );
  }

  console.log('🔑 Seller Entity:', sellerEntityId);
  console.log('👛 Seller Wallet:', sellerWalletAddress);

  const acpContractClient = await AcpContractClientV2.build(
    privateKey,
    sellerEntityId,
    sellerWalletAddress,
    process.env.CUSTOM_RPC_URL || undefined,
    undefined
  );

  const acpClient = new AcpClient({
    acpContractClient,

    onNewTask: async (job, memoToSign) => {
      console.log('🟢 New job received:', job.id);
      console.log('📌 Job phase:', job.phase);
      console.log('📥 Job input keys:', job.input ? Object.keys(job.input) : []);
      console.log('📝 Memo to sign:', memoToSign);

      if (!memoToSign || memoToSign.status !== 'PENDING') {
        console.log('⚪ No pending memo to act on.');
        return;
      }

      // Phase 0 -> 1: negotiation / acceptance
      if (memoToSign.nextPhase === 1) {
        try {
          const structured = memoToSign.structuredContent;
          if (structured && structured.name) {
            jobMetadata.set(job.id, structured);
            console.log(
              '💾 Stored job metadata:',
              structured.name,
              Object.keys(structured.requirement || {})
            );
          }

          console.log('🤝 Responding to job (accepting)...');
          await job.respond(true, 'Auto-accepting job from DeFi Yield Optimizer provider');
          console.log('✅ Job accepted:', job.id);
        } catch (err) {
          console.error('❌ Error accepting job:', err);
          await job.respond(false, `Error during negotiation: ${String(err)}`);
        }
        return;
      }

      // Phase 2 -> 3: delivery
      if (memoToSign.nextPhase === 3) {
        console.log('📦 Preparing deliverable for job...');

        let metadata = jobMetadata.get(job.id);
        if (!metadata && memoToSign.structuredContent) {
          metadata = memoToSign.structuredContent;
        }

        if (!metadata && typeof memoToSign.content === 'string') {
          try {
            const parsed = JSON.parse(memoToSign.content);
            if (parsed && parsed.name) {
              metadata = parsed;
            }
          } catch {
            // ignore parse error
          }
        }

        if (metadata) {
          console.log(
            '📁 Loaded job metadata:',
            metadata.name,
            Object.keys(metadata.requirement || {})
          );
        } else {
          console.log('⚠️ No metadata found; delivering unknown job response.');
        }

        const deliverable = routeJobDeliverable(metadata);

        try {
          await job.deliver(deliverable);
          console.log('✅ Job delivered:', job.id);
          jobMetadata.delete(job.id);
        } catch (err) {
          console.error('❌ Error delivering job result:', err);
          try {
            await job.deliver({
              job_name: 'unknown',
              timestamp_utc: nowIso(),
              validation_passed: false,
              validation_errors: [
                validationError('Delivery failed internally', 'internal'),
                validationError(String(err), 'exception')
              ]
            });
          } catch (err2) {
            console.error('❌ Secondary delivery error:', err2);
          }
        }
        return;
      }

      console.log('⚪ Memo nextPhase not handled:', memoToSign.nextPhase);
    },

    onEvaluate: async (job) => {
      console.log('📊 onEvaluate called for job:', job.id, 'phase:', job.phase);
      // Optional: add evaluator logic later
    }
  });

  console.log('🚀 Initializing ACP client for DeFi Yield Optimizer (V2)...');
  if (typeof acpClient.init === 'function') {
    await acpClient.init();
  }
  console.log('🟢 ACP client initialized. Waiting for jobs...');

  setInterval(() => {
    console.log('⏱ Heartbeat: DeFi Yield Optimizer provider is still running...');
  }, 60000);
}

main().catch((err) => {
  console.error('❌ FATAL ERROR:', err);
  process.exit(1);
});
