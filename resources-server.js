// resources-server.js
// Lightweight HTTP API for DeFi Yield Optimizer resources.
// Designed to run on Render / Railway / any Node host.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Render (and most PaaS) provide PORT via env var
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ---------- Common metadata helper ----------

function makeResponse(data, metaExtra = {}) {
  return {
    ok: true,
    data,
    meta: {
      generated_at_utc: new Date().toISOString(),
      ...metaExtra
    }
  };
}

function makeError(message, status = 400, metaExtra = {}) {
  return {
    status,
    body: {
      ok: false,
      error: message,
      meta: {
        generated_at_utc: new Date().toISOString(),
        ...metaExtra
      }
    }
  };
}

// ---------- Synthetic catalogs ----------

// Chain risk catalog (very opinionated & synthetic)
const CHAIN_RISK_CATALOG = {
  'ethereum-mainnet': {
    risk_factor: 0.8,
    typical_gas_band_usd: '5-25',
    maturity_score: 95,
    notes: [
      'Most battle-tested DeFi ecosystem.',
      'High liquidity and blue-chip protocol density.',
      'Gas costs can be elevated during peak congestion.'
    ]
  },
  base: {
    risk_factor: 1.0,
    typical_gas_band_usd: '0.1-2',
    maturity_score: 80,
    notes: [
      'L2 with strong infra backing and growing DeFi footprint.',
      'Lower gas environment ideal for more active strategies.',
      'Ecosystem still evolving; long-tail protocols require extra scrutiny.'
    ]
  },
  arbitrum: {
    risk_factor: 1.0,
    typical_gas_band_usd: '0.2-3',
    maturity_score: 85,
    notes: [
      'Large DeFi ecosystem with multiple major DEXes and lending markets.',
      'Good depth for many large-cap pairs.',
      'Bridge and cross-chain complexity should be considered in risk budget.'
    ]
  },
  optimism: {
    risk_factor: 1.05,
    typical_gas_band_usd: '0.2-3',
    maturity_score: 78,
    notes: [
      'Growing ecosystem with strong incentives in phases.',
      'Protocol set somewhat concentrated vs Ethereum mainnet.',
      'Careful sizing recommended for new/incentivized programs.'
    ]
  }
};

function getChainRisk(chainRaw) {
  const key = (chainRaw || '').toLowerCase();
  const exact =
    CHAIN_RISK_CATALOG[key] ||
    CHAIN_RISK_CATALOG[key.replace('-one', '')] ||
    CHAIN_RISK_CATALOG[key.replace('-mainnet', '')];

  if (exact) {
    return {
      chain: chainRaw,
      ...exact
    };
  }

  return {
    chain: chainRaw || 'unknown',
    risk_factor: 1.2,
    typical_gas_band_usd: '0.1-10',
    maturity_score: 60,
    notes: [
      'Unknown or less-modeled chain; treat as higher beta by default.',
      'Use conservative sizing until battle-tested DeFi primitives emerge.'
    ]
  };
}

// Asset profile catalog (synthetic classification)
function classifyAsset(symbolRaw) {
  const s = (symbolRaw || '').toUpperCase();

  if (['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD'].includes(s)) {
    return {
      asset: s,
      asset_type: 'stablecoin',
      tags: ['usd-pegged', 'collateral-candidate'],
      risk_flags: ['depeg'],
      summary: 'Stablecoin with USD peg; yields often come from lending and low-volatility venues.'
    };
  }

  if (['ETH', 'WETH', 'WBTC'].includes(s)) {
    return {
      asset: s,
      asset_type: 'bluechip',
      tags: ['volatile', 'bluechip', 'collateral-candidate'],
      risk_flags: ['price-volatility'],
      summary:
        'Blue-chip asset with deep liquidity; common collateral and LP leg across DeFi ecosystems.'
    };
  }

  if (s.includes('-LP') || s.includes('/')) {
    return {
      asset: s,
      asset_type: 'lp_token',
      tags: ['lp', 'pool-share', 'impermanent-loss'],
      risk_flags: ['impermanent-loss', 'liquidity'],
      summary:
        'LP token representing a share of a pool. Yields depend on fees and incentives; exposed to IL.'
    };
  }

  return {
    asset: s,
    asset_type: 'long_tail',
    tags: ['volatile', 'idiosyncratic'],
    risk_flags: ['smart-contract', 'liquidity', 'tokenomics'],
    summary:
      'Long-tail or less-battle-tested asset. Treat allocations as higher risk with capped sizing.'
  };
}

function enrichAssetProfileWithDetail(baseProfile, chainRaw, detailLevel) {
  const chainContext = chainRaw ? chainRaw.toLowerCase() : null;
  const detail = detailLevel || 'summary';

  const base = {
    ...baseProfile,
    chain_context: chainRaw || null
  };

  if (detail === 'summary') {
    return base;
  }

  // "full" detail: add synthetic guidance & example venues
  let typicalVenues = [];
  let monitoringHints = [];
  let sizingGuidance = '';

  switch (baseProfile.asset_type) {
    case 'stablecoin':
      typicalVenues = ['lending-markets', 'stable-stable LPs', 'conservative yield vaults'];
      monitoringHints = [
        'Track peg stability vs USD on major venues.',
        'Monitor protocol announcements for collateral / backing changes.'
      ];
      sizingGuidance =
        'Can be a core portfolio component, but concentration in a single stablecoin should be limited.';
      break;
    case 'bluechip':
      typicalVenues = ['lending-markets', 'volatile LPs (e.g., ETH-stable)', 'perp funding plays'];
      monitoringHints = [
        'Track market beta and macro conditions.',
        'Monitor funding and open interest if used with perps.'
      ];
      sizingGuidance =
        'Often suitable for larger allocations, but still subject to significant price volatility.';
      break;
    case 'lp_token':
      typicalVenues = ['DEX LPs', 'yield farms', 'aggregator vaults'];
      monitoringHints = [
        'Monitor IL vs holding underlying assets.',
        'Track incentives cliffs and gauge changes.'
      ];
      sizingGuidance =
        'Cap LP exposure relative to core holdings; size based on IL tolerance and time horizon.';
      break;
    default:
      typicalVenues = ['experimental vaults', 'high-incentive farms'];
      monitoringHints = [
        'Track token emissions and unlock schedules.',
        'Monitor liquidity depth across major venues.'
      ];
      sizingGuidance =
        'Treat allocations as “degen bucket”; assume potential near-total loss in worst case.';
      break;
  }

  return {
    ...base,
    typical_venues: typicalVenues,
    monitoring_hints: monitoringHints,
    sizing_guidance: sizingGuidance,
    chain_specific_note: chainContext
      ? `Profiles are synthetic; always validate actual liquidity and usage for ${chainContext}.`
      : 'Profiles are synthetic and chain-agnostic; validate per chain before use.'
  };
}

// Yield risk playbook (bucket guardrails etc.)
function getYieldRiskPlaybook(riskTolerance, archetype, useCase) {
  const rt = (riskTolerance || 'balanced').toLowerCase();
  const arch = (archetype || 'core').toLowerCase();
  const uc = (useCase || 'allocation_planning').toLowerCase();

  // Base guardrails by archetype
  let baseGuardrails;
  if (arch === 'core') {
    baseGuardrails = [
      'Prefer battle-tested protocols with audits and long on-chain history.',
      'Avoid leverage or keep it modest (<= 1.3x) unless explicitly mandated.',
      'Ensure TVL and liquidity are comfortably above internal thresholds.'
    ];
  } else if (arch === 'satellite') {
    baseGuardrails = [
      'Limit per-position loss to a tolerable fraction of portfolio risk budget.',
      'Avoid highly experimental contracts without clear security posture.',
      'Require reasonable volume / utilization to avoid liquidity traps.'
    ];
  } else {
    baseGuardrails = [
      'Assume potential near-total loss; size accordingly.',
      'Isolate these positions in separate addresses or accounts when possible.',
      'Require explicit monitoring and alerting for each experimental position.'
    ];
  }

  // Extra overlays by risk_tolerance
  let overlays = [];
  if (rt === 'conservative') {
    overlays = [
      'Bias toward capital preservation over headline APY.',
      'Downweight complex multi-hop or leveraged strategies.',
      'Prioritize exit liquidity and operational simplicity.'
    ];
  } else if (rt === 'aggressive') {
    overlays = [
      'Allow higher volatility buckets but enforce hard notional caps.',
      'Expect elevated drawdowns; embed guardrails instead of hard avoidance.',
      'Rotate more quickly out of decaying incentive programs.'
    ];
  } else {
    overlays = [
      'Balance stable yield sources with a limited risk budget for high-APY legs.',
      'Avoid “all or nothing” positions; focus on diversified risk carriers.'
    ];
  }

  // Use-case specific hints
  let useCaseHints = [];
  if (uc === 'allocation_planning') {
    useCaseHints = [
      'Define explicit bucket sizing (core / satellite / experimental) before choosing protocols.',
      'Make scenario analysis on drawdowns a first-class input to sizing decisions.'
    ];
  } else if (uc === 'execution') {
    useCaseHints = [
      'Avoid over-optimizing for single-transaction gas savings at the expense of clarity.',
      'Prefer deterministic execution order that makes rollback/recovery easier.'
    ];
  } else if (uc === 'monitoring') {
    useCaseHints = [
      'Set alert thresholds well before liquidation or critical health levels.',
      'Bucket alerts by severity so operators are not flooded during volatile periods.'
    ];
  }

  return {
    risk_tolerance: rt,
    archetype: arch,
    use_case: uc,
    guardrails: baseGuardrails,
    overlays,
    use_case_hints: useCaseHints,
    recommended_rebalancing_days:
      arch === 'core' ? (rt === 'conservative' ? 30 : 21) : arch === 'satellite' ? 14 : 7
  };
}

// ---------- Endpoints ----------

// Health check
app.get('/healthz', (_req, res) => {
  res.json(makeResponse({ status: 'ok' }, { service: 'defi-yield-resources' }));
});

// 1) Chain risk resource
// URL: /resources/chain-risk
// Query: ?chain=base
app.get('/resources/chain-risk', (req, res) => {
  const { chain } = req.query;

  if (!chain || typeof chain !== 'string') {
    const err = makeError('Missing required query parameter: chain', 400, {
      resource: 'defi_chain_risk_catalog'
    });
    return res.status(err.status).json(err.body);
  }

  const profile = getChainRisk(chain);

  return res.json(
    makeResponse(profile, {
      resource: 'defi_chain_risk_catalog',
      input: { chain }
    })
  );
});

// 2) Asset profiles resource
// URL: /resources/asset-profiles
// Query: ?asset=USDC&chain=base&detail_level=full
app.get('/resources/asset-profiles', (req, res) => {
  const { asset, chain, detail_level } = req.query;

  if (!asset || typeof asset !== 'string') {
    const err = makeError('Missing required query parameter: asset', 400, {
      resource: 'defi_asset_profile_catalog'
    });
    return res.status(err.status).json(err.body);
  }

  const baseProfile = classifyAsset(asset);
  const fullProfile = enrichAssetProfileWithDetail(
    baseProfile,
    chain,
    detail_level
  );

  return res.json(
    makeResponse(fullProfile, {
      resource: 'defi_asset_profile_catalog',
      input: { asset, chain: chain || null, detail_level: detail_level || 'summary' }
    })
  );
});

// 3) Yield risk playbook resource
// URL: /resources/yield-risk-playbook
// Query: ?risk_tolerance=balanced&archetype=core&use_case=allocation_planning
app.get('/resources/yield-risk-playbook', (req, res) => {
  const { risk_tolerance, archetype, use_case } = req.query;

  if (!risk_tolerance || typeof risk_tolerance !== 'string') {
    const err = makeError('Missing required query parameter: risk_tolerance', 400, {
      resource: 'defi_yield_risk_playbook'
    });
    return res.status(err.status).json(err.body);
  }

  const playbook = getYieldRiskPlaybook(risk_tolerance, archetype, use_case);

  return res.json(
    makeResponse(playbook, {
      resource: 'defi_yield_risk_playbook',
      input: { risk_tolerance, archetype: archetype || null, use_case: use_case || null }
    })
  );
});

// ---------- Start server ----------

app.listen(PORT, () => {
  console.log(`🟢 DeFi Yield resources server listening on port ${PORT}`);
  console.log('   Available endpoints:');
  console.log('   GET /healthz');
  console.log('   GET /resources/chain-risk?chain=base');
  console.log('   GET /resources/asset-profiles?asset=USDC&chain=base&detail_level=full');
  console.log(
    '   GET /resources/yield-risk-playbook?risk_tolerance=balanced&archetype=core&use_case=allocation_planning'
  );
});
