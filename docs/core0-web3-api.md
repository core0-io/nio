# Core0 Web3 API Integration

Core0 AgentGuard optionally uses the **Core0 Web3 security API** for enhanced on-chain checks. The default HTTP backend is the [GoPlus Security API](https://gopluslabs.io/security-api) (third-party provider).

## Setup

Preferred environment variables:

```bash
export CORE0_WEB3_API_KEY=your_key
export CORE0_WEB3_API_SECRET=your_secret
```

Legacy names (still supported):

```bash
export GOPLUS_API_KEY=your_key
export GOPLUS_API_SECRET=your_secret
```

Obtain provider keys at: https://gopluslabs.io/security-api

## What It Adds

Without Core0 Web3 API credentials, AgentGuard uses local pattern matching for Web3 security (unlimited approvals, reentrancy, selfdestruct, etc.).

With credentials configured, you get additional capabilities:

- **Token Security**: Check if a token is a honeypot, has a tax, or has other risks
- **Address Security**: Check if an address is associated with phishing, scams, or malicious activity
- **Transaction Simulation**: Simulate a transaction to see its effects before execution
- **Approval Security**: Check for risky token approvals
- **dApp Security**: Verify the safety of decentralized applications

## Graceful Degradation

If the Web3 API is unavailable or keys are not configured, AgentGuard falls back to local-only analysis. No functionality is lost — you just get fewer Web3-specific insights.

## External Scanner

Core0 AgentGuard also integrates with [cisco-ai-defense/skill-scanner](https://github.com/cisco-ai-defense/skill-scanner) for additional scanning capabilities:

```bash
pip install cisco-ai-skill-scanner
```

This adds YAML/YARA pattern scanning, Python AST analysis, and VirusTotal integration.
