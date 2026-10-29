# Public engine and private integration boundary

The engine is Apache-2.0 software. The hosted AI integration is a separate,
proprietary product. This separation does not restrict uses already permitted
by the engine license.

## Public engine

Keep reusable game APIs, simulation, rendering, physics, networking, animation,
UI, asset formats, compilers, validators and bounded diagnostics here. Include
standalone examples and reference documentation for those APIs. Functions accept
explicit game data and return results without requiring a product account,
model provider or hosted workflow.

## Private integration

Keep the hosted protocol server, tool registration and request contracts,
authentication, provider calls, prompts, agent loops, context selection, retry and
budget policies, task queues, saved review workflows, publishing and billing in
the private platform. Integration-specific handbooks stay there too.

A reusable model validator belongs here. The service that authorizes a user,
loads a saved revision, schedules the validator and presents its result to an
AI belongs in the private integration.

## Dependency direction

The private integration imports a pinned engine version. The engine must not
import private platform modules or provider SDKs. Do not copy engine code into
the integration to work around this rule; extract a provider-independent API
when a shared capability is missing.

Public documentation explains engine behavior, not private tool names, request
shapes, service limits or account workflows. Mentioning the existence of the
private product does not make its implementation part of this repository.

## Release checks

`npm run check:boundary` checks source placement, dependency declarations and
private implementation markers. `npm run check:package` also checks the package
file inventory. Tests exercise rejection cases. The private platform additionally
checks public content against its current tool registry, without publishing that
registry into this repository.

Previously published code and documentation remain available under their prior
licenses. This boundary governs future development and publication.
