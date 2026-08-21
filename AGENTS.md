# AGENTS.md

## Vision

This project is a bridge that lets OpenAI- and Anthropic-based clients use a server as a base from which they can act on resources inside that server or elsewhere the server can reach.

OpenAI and Anthropic are first-class targets. Other clients and protocols are welcome when they do not compromise functionality, reliability, or performance for those two.

## Guardrails

- Keep execution transport and access as the core responsibility; the server should enable capable clients rather than become the intelligence itself.
- OpenAI and Anthropic support must remain first-class and must not be degraded to accommodate secondary integrations.
- Backwards compatibility may be broken when there is a clear technical benefit and the change is intentional and documented.
- A bounded terminal/execution primitive remains the core architectural unit.
- The long-term vision is broad reach: clients should be able to use the server to operate on local resources and on remote resources reachable from it.
- Remain a bridge by default. Add orchestration, scheduling, agent logic, dashboards, or other platform features only when there is a strong technical justification and concrete delivery value.
