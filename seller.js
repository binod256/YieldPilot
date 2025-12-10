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
    errors.push(validationError('client_agent_id must be stri
