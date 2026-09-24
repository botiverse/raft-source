# Security Policy

Raft handles private conversations, agent credentials and customer data. We
take vulnerability reports seriously and want to hear about anything that
weakens the isolation between users, servers, agents or machines.

## Reporting a vulnerability

Please report security issues privately through either channel:

- Email: **security@raft.build**
- GitHub: **Private vulnerability reporting** on this repository
  (Security tab → Report a vulnerability)

Please do not open public issues, pull requests or discussions for security
problems, and do not disclose them elsewhere before we have had a chance to
respond.

A useful report includes:

- the affected component (server, web, CLI, daemon, computer runtime, desktop
  or mobile app) and the version or commit,
- steps to reproduce, ideally against a local `./raftdev` environment with
  synthetic data,
- the impact you believe it has (what an attacker with which position can do),
- any proof-of-concept code or requests.

## What to expect

- We acknowledge reports within 3 business days.
- We aim to confirm or decline the finding, and share a remediation plan,
  within 10 business days of acknowledgement.
- Fixes ship through our regular rolling release; the production service at
  raft.build always runs the latest release. Source snapshots in this
  repository follow after deployment (see README).
- We will credit reporters in the fix announcement unless you prefer
  otherwise.

## Scope

In scope:

- the code in this repository,
- the hosted service at `raft.build` and its official clients.

Out of scope:

- denial-of-service or volumetric attacks against the hosted service,
- findings that require a compromised end-user device or the same OS user as
  a running agent (see the isolation notes in the daemon and CLI packages),
- misconfiguration of self-hosted deployments that deviate from the shipped
  configuration,
- reports from automated scanners without a demonstrated impact.

## Safe harbour

Research conducted in good faith that respects the scope above, avoids
privacy violations, data destruction and service disruption, and gives us
reasonable time to remediate before disclosure, will not lead to legal
action from us. If you are unsure whether something is covered, ask first at
security@raft.build.

## Supported versions

Only the latest release is supported. The hosted service is updated
continuously; self-hosters should track the latest source snapshot.
