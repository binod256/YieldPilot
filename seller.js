// seller.js — YieldPilot DeFi Provider (matches given requirements & deliverables)
require('dotenv').config();

const AcpClientModule = require('@virtuals-protocol/acp-node');
const AcpClient = AcpClientModule.default;
const { AcpContractClientV2 } = AcpClientModule;

// Simple in-memory cache for job metadata
const jobMetadata = new Map();

/* ---------------------- Helper utilities ---------------------- */

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

/* --------------------- JOB 1: yield_scan_and_ranking --------------------- */
/*
Requirement (summary):
- client_agent_id: string
- chain: string
- assets: string[]
- risk_tolerance: string
- min_tvl_usd: number
- lookback_hours: number

Deliverable (summary):
- job_name: "yield_scan_and_ranking"
- chain: string
- assets: string[]
- timestamp_utc: string
- results: array of {
    protocol, pool_address, asset, estimated_apy (number),
    tvl_usd (string), risk_score (number), strategy_hint (string)
  }
*/

function validateYieldScan(input) {
  const errors = [];

  if (!ensureString(input.client_agent_id)) {
    errors.push(validationError('client_agent_id must be string', 'client_agent_id'));
  }
  if (!ensureString(input.chain)) {
    errors.push(validationError('chain must be string', 'chain'));
  }
  if (!ensureArray(input.assets)) {
    errors.push(validationError('assets must be array of strings', 'assets'));
  } else if (!input.assets.every(ensureString)) {
    errors.push(validationError('assets items must be strings', 'assets'));
  }
  if (!ensureString(input.risk_tolerance)) {
    errors.push(validationError('risk_tolerance must be string', 'risk_tolerance'));
  }
  if (!ensureNumber(input.min_tvl_usd)) {
    errors.push(validationError('min_tvl_usd must be number', 'min_tvl_usd'));
  }
  if (!ensureNumber(input.lookback_hours)) {
    errors.push(validationError('lookback_hours must be number', 'lookback_hours'));
  }

  return errors;
}

function syntheticRiskFromApy(apy, tvl, minTvl) {
  // Very simple heuristic: higher APY + lower TVL => higher risk
  let score = 20;

  if (apy > 20) score += 20;
  else if (apy > 10) score += 10;
  else if (apy > 5) score += 5;

  if (tvl < minTvl * 2) score += 15;
  else if (tvl < minTvl * 5) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function handleYieldScan(input) {
  const errors = validateYieldScan(input);
  const validationPassed = errors.length === 0;

  const chain = input.chain || 'unknown';
  const assets = ensureArray(input.assets) ? input.assets : [];
  const minTvl = ensureNumber(input.min_tvl_usd) ? input.min_tvl_usd : 50000;
  const rt = input.risk_tolerance || 'moderate';

  const results = [];

  assets.forEach((assetSymbol) => {
    const baseName = assetSymbol.toUpperCase();

    // Construct three synthetic venues per asset
    const venues = [
      {
        protocol: 'SafeLend',
        apy: rt === 'aggressive' ? 6 : 3,
        tvl: minTvl * 10,
        hint: `Stable ${baseName} lending, lower risk and modest yield.`
      },
      {
        protocol: 'YieldDex',
        apy: rt === 'conservative' ? 8 : 12,
        tvl: minTvl * 5,
        hint: `DEX / LP style yield for ${baseName} with balanced risk-reward.`
      },
      {
        protocol: 'TurboFarm',
        apy: rt === 'aggressive' ? 35 : 25,
        tvl: minTvl * 2,
        hint: `Incentivized farm for ${baseName} with substantially higher risk.`
      }
    ];

    venues.forEach((v, idx) => {
      const riskScore = syntheticRiskFromApy(v.apy, v.tvl, minTvl);
      results.push({
        protocol: v.protocol,
        pool_address: `0x${baseName.slice(0, 4)}${idx.toString().padStart(2, '0')}Pool`,
        asset: baseName,
        estimated_apy: v.apy,
        tvl_usd: String(Math.round(v.tvl)), // deliverable expects string
        risk_score: riskScore,
        strategy_hint: v.hint
      });
    });
  });

  // Sort by APY descending, then lower risk
  results.sort((a, b) => {
    if (b.estimated_apy === a.estimated_apy) {
      return a.risk_score - b.risk_score;
    }
    return b.estimated_apy - a.estimated_apy;
  });

  return {
    job_name: 'yield_scan_and_ranking',
    chain,
    assets,
    timestamp_utc: nowIso(),
    results,
    // extra (not required but useful):
    validation_passed: validationPassed,
    validation_errors: errors
  };
}

/* ----------------- JOB 2: portfolio_yield_allocation_plan ----------------- */
/*
Requirement:
- client_agent_id, chain, starting_capital_usd, risk_tolerance, target_horizon_days, preferences
- preferences: { allow_leverage (bool), allow_lockups (bool), max_positions (number) }

Deliverable:
- job_name: "portfolio_yield_allocation_plan"
- chain, starting_capital_usd, risk_tolerance, timestamp_utc,
  estimated_portfolio_apy (number),
  estimated_risk_score (number),
  allocations: [
    {
      protocol, pool_address, asset,
      allocation_usd, allocation_percent,
      est_apy, notes
    }
  ]
*/

function validatePortfolioPlan(input) {
  const errors = [];

  if (!ensureString(input.client_agent_id)) {
    errors.push(validationError('client_agent_id must be string', 'client_agent_id'));
  }
  if (!ensureString(input.chain)) {
    errors.push(validationError('chain must be string', 'chain'));
  }
  if (!ensureNumber(input.starting_capital_usd)) {
    errors.push(
      validationError('starting_capital_usd must be number', 'starting_capital_usd')
    );
  }
  if (!ensureString(input.risk_tolerance)) {
    errors.push(validationError('risk_tolerance must be string', 'risk_tolerance'));
  }
  if (!ensureNumber(input.target_horizon_days)) {
    errors.push(
      validationError('target_horizon_days must be number', 'target_horizon_days')
    );
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
  const validationPassed = errors.length === 0;

  const chain = input.chain || 'unknown';
  const capital = ensureNumber(input.starting_capital_usd)
    ? input.starting_capital_usd
    : 0;
  const rt = input.risk_tolerance || 'moderate';
  const prefs = input.preferences || {
    allow_leverage: false,
    allow_lockups: false,
    max_positions: 3
  };

  const maxPositions = Math.max(1, Math.round(prefs.max_positions));

  // Simple bucket weights depending on risk_tolerance
  let weights;
  if (rt === 'conservative') {
    weights = [0.7, 0.25, 0.05]; // core, growth, degen
  } else if (rt === 'aggressive') {
    weights = [0.4, 0.4, 0.2];
  } else {
    // moderate
    weights = [0.55, 0.3, 0.15];
  }

  const [wCore, wGrowth, wDegen] = weights;

  const legs = [];

  function pushLeg(protocol, asset, w, baseApy, noteSuffix) {
    const allocationUsd = capital * w;
    if (allocationUsd <= 0) return;

    const estApy = baseApy;
    const allocationPercent = w * 100;

    legs.push({
      protocol,
      pool_address: `0x${protocol.slice(0, 4)}${asset.slice(0, 3)}Pool`,
      asset,
      allocation_usd: Math.round(allocationUsd * 100) / 100,
      allocation_percent: Math.round(allocationPercent * 10) / 10,
      est_apy: estApy,
      notes: noteSuffix
    });
  }

  // Core leg – stable, non-levered
  pushLeg(
    'SafeLend',
    'USDC',
    wCore,
    rt === 'aggressive' ? 7 : rt === 'conservative' ? 3 : 5,
    'Core stablecoin lending leg focused on principal preservation.'
  );

  // Growth leg – blue-chip yield
  pushLeg(
    'YieldDex',
    'WETH',
    wGrowth,
    rt === 'aggressive' ? 15 : 10,
    'Growth leg with blue-chip exposure via LPs or vaults.'
  );

  // Degen leg – only if prefs allow
  if (wDegen > 0 && (prefs.allow_leverage || prefs.allow_lockups)) {
    pushLeg(
      'TurboFarm',
      'VOL',
      wDegen,
      rt === 'aggressive' ? 35 : 25,
      'Higher-risk, higher-reward leg sized as a smaller portion of capital.'
    );
  }

  // Respect max_positions by truncating if needed
  const allocations = legs.slice(0, maxPositions);

  // Compute simple weighted portfolio APY and risk score
  let estimatedPortfolioApy = 0;
  let estimatedRiskScore = 0;

  if (capital > 0 && allocations.length > 0) {
    allocations.forEach((leg) => {
      const weight = leg.allocation_usd / capital;
      estimatedPortfolioApy += leg.est_apy * weight;

      // crude synthetic risk: function of APY
      const risk =
        leg.est_apy < 8 ? 20 : leg.est_apy < 20 ? 45 : 70;
      estimatedRiskScore += risk * weight;
    });
  }

  estimatedPortfolioApy = Math.round(estimatedPortfolioApy * 10) / 10;
  estimatedRiskScore = Math.round(estimatedRiskScore);

  return {
    job_name: 'portfolio_yield_allocation_plan',
    chain,
    starting_capital_usd: capital,
    risk_tolerance: rt,
    timestamp_utc: nowIso(),
    estimated_portfolio_apy: estimatedPortfolioApy,
    estimated_risk_score: estimatedRiskScore,
    allocations,
    // extra:
    validation_passed: validationPassed,
    validation_errors: errors
  };
}

/* ----------------- JOB 3: execution_bundle_builder ----------------- */
/*
Requirement:
- client_agent_id: string
- chain: string
- desired_allocations: [
    {
      asset_in, asset_out, amount_in, venue,
      slippage_bps, deadline_seconds, prefer_batching
    }
  ]

Deliverable:
- job_name: "execution_bundle_builder"
- chain, timestamp_utc, bundle_id, estimated_gas_cost_usd, txs
- txs: [
    {
      description, to, data, value, gas_limit_hint, warnings[]
    }
  ]
*/

function validateExecutionBundle(input) {
  const errors = [];

  if (!ensureString(input.client_agent_id)) {
    errors.push(validationError('client_agent_id must be string', 'client_agent_id'));
  }
  if (!ensureString(input.chain)) {
    errors.push(validationError('chain must be string', 'chain'));
  }
  if (!ensureArray(input.desired_allocations)) {
    errors.push(
      validationError('desired_allocations must be array', 'desired_allocations')
    );
  } else {
    input.desired_allocations.forEach((item, idx) => {
      const prefix = `desired_allocations[${idx}]`;

      if (!ensureString(item.asset_in)) {
        errors.push(
          validationError(`${prefix}.asset_in must be string`, `${prefix}.asset_in`)
        );
      }
      if (!ensureString(item.asset_out)) {
        errors.push(
          validationError(`${prefix}.asset_out must be string`, `${prefix}.asset_out`)
        );
      }
      if (!ensureNumber(item.amount_in)) {
        errors.push(
          validationError(`${prefix}.amount_in must be number`, `${prefix}.amount_in`)
        );
      }
      if (!ensureString(item.venue)) {
        errors.push(
          validationError(`${prefix}.venue must be string`, `${prefix}.venue`)
        );
      }
      if (!ensureNumber(item.slippage_bps)) {
        errors.push(
          validationError(
            `${prefix}.slippage_bps must be number`,
            `${prefix}.slippage_bps`
          )
        );
      }
      if (!ensureNumber(item.deadline_seconds)) {
        errors.push(
          validationError(
            `${prefix}.deadline_seconds must be number`,
            `${prefix}.deadline_seconds`
          )
        );
      }
      if (!ensureBoolean(item.prefer_batching)) {
        errors.push(
          validationError(
            `${prefix}.prefer_batching must be boolean`,
            `${prefix}.prefer_batching`
          )
        );
      }
    });
  }

  return errors;
}

function handleExecutionBundle(input) {
  const errors = validateExecutionBundle(input);
  const validationPassed = errors.length === 0;

  const chain = input.chain || 'unknown';
  const allocations = ensureArray(input.desired_allocations)
    ? input.desired_allocations
    : [];
  const bundleId = `bundle_${chain}_${Date.now()}`;

  const txs = allocations.map((alloc, idx) => {
    const sizeCategory =
      alloc.amount_in < 1000
        ? 'small'
        : alloc.amount_in < 100000
        ? 'medium'
        : 'large';

    const warnings = [];

    if (alloc.slippage_bps > 100) {
      warnings.push(
        `High slippage tolerance (${alloc.slippage_bps} bps); double-check price impact.`
      );
    }
    if (alloc.deadline_seconds < 300) {
      warnings.push(
        `Short deadline (${alloc.deadline_seconds} seconds); may fail in volatile markets.`
      );
    }
    if (!alloc.prefer_batching) {
      warnings.push('Batching disabled; more individual txs may be required.');
    }

    if (sizeCategory === 'large') {
      warnings.push('Large notional size; check venue depth and slippage carefully.');
    }

    return {
      description: `Swap/route from ${alloc.asset_in} to ${alloc.asset_out} on ${alloc.venue}`,
      to: `0xRouter${idx.toString().padStart(2, '0')}Address`,
      data: `0x${(1000 + idx).toString(16)}deadbeef`,
      value: '0',
      gas_limit_hint: alloc.venue.toLowerCase().includes('lend') ? 350000 : 220000,
      warnings
    };
  });

  const estimatedGasCostUsd =
    Math.round(txs.length * 1.5 * 100) / 100; // simple synthetic estimate

  return {
    job_name: 'execution_bundle_builder',
    chain,
    timestamp_utc: nowIso(),
    bundle_id: bundleId,
    estimated_gas_cost_usd: estimatedGasCostUsd,
    txs,
    // extra:
    validation_passed: validationPassed,
    validation_errors: errors
  };
}

/* ----------------- JOB 4: position_health_monitor ----------------- */
/*
Requirement:
- client_agent_id: string
- chain: string
- positions: [
    {
      protocol, pool_address, position_id,
      health_threshold, notify_channel, check_frequency_minutes
    }
  ]

Deliverable:
- job_name: "position_health_monitor"
- chain, timestamp_utc,
  positions: [
    {
      protocol, pool_address, position_id,
      health_score, breach, issues[], recommendation
    }
  ]
*/

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
      const prefix = `positions[${idx}]`;
      if (!ensureString(pos.protocol)) {
        errors.push(
          validationError(`${prefix}.protocol must be string`, `${prefix}.protocol`)
        );
      }
      if (!ensureString(pos.pool_address)) {
        errors.push(
          validationError(
            `${prefix}.pool_address must be string`,
            `${prefix}.pool_address`
          )
        );
      }
      if (!ensureString(pos.position_id)) {
        errors.push(
          validationError(
            `${prefix}.position_id must be string`,
            `${prefix}.position_id`
          )
        );
      }
      if (!ensureNumber(pos.health_threshold)) {
        errors.push(
          validationError(
            `${prefix}.health_threshold must be number`,
            `${prefix}.health_threshold`
          )
        );
      }
      if (!ensureString(pos.notify_channel)) {
        errors.push(
          validationError(
            `${prefix}.notify_channel must be string`,
            `${prefix}.notify_channel`
          )
        );
      }
      if (!ensureNumber(pos.check_frequency_minutes)) {
        errors.push(
          validationError(
            `${prefix}.check_frequency_minutes must be number`,
            `${prefix}.check_frequency_minutes`
          )
        );
      }
    });
  }

  return errors;
}

function handlePositionHealth(input) {
  const errors = validatePositionHealth(input);
  const validationPassed = errors.length === 0;

  const chain = input.chain || 'unknown';
  const positionsIn = ensureArray(input.positions) ? input.positions : [];

  const positionsOut = positionsIn.map((pos) => {
    const threshold = pos.health_threshold;
    // crude synthetic health model
    let health = 80;

    if (threshold >= 80) {
      health = threshold - 5;
    } else if (threshold >= 60) {
      health = threshold + 5;
    } else {
      health = threshold + 15;
    }

    health = Math.max(0, Math.min(100, Math.round(health)));

    const breach = health < threshold;
    const issues = [];
    let recommendation = 'No immediate action required. Maintain baseline monitoring.';

    if (breach) {
      issues.push('Synthetic health score is below configured threshold.');
      recommendation =
        'Consider reducing leverage, adding collateral, or unwinding the position.';
    } else if (health - threshold < 5) {
      issues.push('Health score is only slightly above threshold.');
      recommendation =
        'Increase monitoring frequency and prepare a risk-reduction playbook.';
    }

    return {
      protocol: pos.protocol,
      pool_address: pos.pool_address,
      position_id: pos.position_id,
      health_score: health,
      breach,
      issues,
      recommendation
    };
  });

  return {
    job_name: 'position_health_monitor',
    chain,
    timestamp_utc: nowIso(),
    positions: positionsOut,
    // extra:
    validation_passed: validationPassed,
    validation_errors: errors
  };
}

/* ----------------- JOB 5: strategy_backtest_report ----------------- */
/*
Requirement:
- client_agent_id, chain, strategy_name,
  backtest_start_utc, backtest_end_utc,
  initial_capital_usd, simulated_actions[]

Deliverable:
- job_name: "strategy_backtest_report"
- chain, strategy_name, timestamp_utc,
  total_return_pct, max_drawdown_pct, volatility_pct,
  trade_count, equity_curve[ { timestamp_utc, equity_usd, key_events[] } ]
*/

function validateBacktest(input) {
  const errors = [];

  if (!ensureString(input.client_agent_id)) {
    errors.push(validationError('client_agent_id must be string', 'client_agent_id'));
  }
  if (!ensureString(input.chain)) {
    errors.push(validationError('chain must be string', 'chain'));
  }
  if (!ensureString(input.strategy_name)) {
    errors.push(
      validationError('strategy_name must be string', 'strategy_name')
    );
  }
  if (!ensureString(input.backtest_start_utc)) {
    errors.push(
      validationError('backtest_start_utc must be string', 'backtest_start_utc')
    );
  }
  if (!ensureString(input.backtest_end_utc)) {
    errors.push(
      validationError('backtest_end_utc must be string', 'backtest_end_utc')
    );
  }
  if (!ensureNumber(input.initial_capital_usd)) {
    errors.push(
      validationError('initial_capital_usd must be number', 'initial_capital_usd')
    );
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
  const validationPassed = errors.length === 0;

  const chain = input.chain || 'unknown';
  const strategyName = input.strategy_name || 'unknown';
  const initialCapital = ensureNumber(input.initial_capital_usd)
    ? input.initial_capital_usd
    : 0;
  const actions = ensureArray(input.simulated_actions)
    ? input.simulated_actions
    : [];

  const start = new Date(input.backtest_start_utc);
  const end = new Date(input.backtest_end_utc);
  const days =
    isNaN(start.getTime()) || isNaN(end.getTime())
      ? 30
      : Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

  // Very simple synthetic performance model
  const complexityFactor = Math.min(3, Math.max(0.5, actions.length / 10));
  const baseAnnualReturn =
    complexityFactor <= 0.8 ? 0.08 : complexityFactor <= 1.5 ? 0.18 : 0.3;

  const syntheticEdge =
    strategyName.toLowerCase().includes('neutral') ? 0.02 : 0;
  const syntheticDrag =
    strategyName.toLowerCase().includes('degen') ||
    strategyName.toLowerCase().includes('leveraged')
      ? 0.05
      : 0;

  const netAnnualReturn = baseAnnualReturn + syntheticEdge - syntheticDrag;
  const periodReturn = netAnnualReturn * (days / 365);
  const endEquity = initialCapital * (1 + periodReturn);

  const totalReturnPct =
    initialCapital > 0
      ? ((endEquity - initialCapital) / initialCapital) * 100
      : 0;

  const maxDrawdownPct = Math.min(
    60,
    Math.max(8, 25 * complexityFactor + (syntheticDrag > 0 ? 10 : 0))
  );
  const volatilityPct = Math.min(
    80,
    Math.max(12, 30 * complexityFactor + (syntheticDrag > 0 ? 10 : 0))
  );

  const steps = [0, 0.25, 0.5, 0.75, 1];
  const equityCurve = steps.map((f, idx) => {
    const tMs = start.getTime() + f * (end.getTime() - start.getTime());
    const tIso = new Date(tMs).toISOString();
    const equity = initialCapital * (1 + periodReturn * f);

    const keyEvents = [];
    if (idx === 0) keyEvents.push('Backtest started.');
    if (idx === steps.length - 1) keyEvents.push('Backtest ended.');
    if (idx === 2) keyEvents.push('Mid-horizon synthetic volatility spike.');

    return {
      timestamp_utc: tIso,
      equity_usd: Math.round(equity * 100) / 100,
      key_events: keyEvents
    };
  });

  return {
    job_name: 'strategy_backtest_report',
    chain,
    strategy_name: strategyName,
    timestamp_utc: nowIso(),
    total_return_pct: Math.round(totalReturnPct * 10) / 10,
    max_drawdown_pct: Math.round(maxDrawdownPct * 10) / 10,
    volatility_pct: Math.round(volatilityPct * 10) / 10,
    trade_count: Math.max(1, actions.length * 3),
    equity_curve: equityCurve,
    // extra:
    validation_passed: validationPassed,
    validation_errors: errors
  };
}

/* ------------------------- Job router ------------------------- */

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

/* ---------------------- ACP bootstrap (V2) ---------------------- */

async function main() {
  const privateKey = process.env.WHITELISTED_WALLET_PRIVATE_KEY;
  const sellerEntityId = process.env.SELLER_ENTITY_ID;
  const sellerWalletAddress = process.env.SELLER_AGENT_WALLET_ADDRESS;

  if (!privateKey || !sellerEntityId || !sellerWalletAddress) {
    throw new Error(
      'Missing env vars. Check .env: WHITELISTED_WALLET_PRIVATE_KEY, SELLER_ENTITY_ID, SELLER_AGENT_WALLET_ADDRESS'
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
          await job.respond(true, 'Auto-accepting job from YieldPilot provider');
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

  console.log('🚀 Initializing ACP client for YieldPilot...');
  if (typeof acpClient.init === 'function') {
    await acpClient.init();
  }
  console.log('🟢 ACP client initialized. Waiting for jobs...');

  setInterval(() => {
    console.log('⏱ Heartbeat: YieldPilot provider is still running...');
  }, 60000);
}

main().catch((err) => {
  console.error('❌ FATAL ERROR:', err);
  process.exit(1);
});
