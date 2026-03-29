---
title: "Team Topologies and Platform Engineering: How You Organize Determines What You Build"
description: "Conway's Law is not a suggestion. The way your teams are structured will determine your architecture — intentionally or not. Here's how to use Team Topologies and platform thinking to make that work for you."
pubDate: 2026-05-17
tags: ["platform-engineering", "team-topologies", "devex", "architecture", "leadership"]
draft: false
---

I've spent years watching Conway's Law operate in real systems — from the inside, not from a textbook.

At Círculo de Crédito, I ran the Architecture Squad: a small team whose job was to enable seven or more engineering squads without becoming a bottleneck for any of them. We also built an Internal Developer Platform on Kubernetes with golden paths for deployment, observability, and secret management. That work put me in direct contact with every tension Team Topologies describes — who owns what, how teams coordinate, what the platform should and shouldn't decide for you.

At Petco, I coordinated across three different teams to deliver platform and architecture capabilities. Different company, same underlying dynamics: team structure shapes the architecture whether you intend it to or not.

This is my attempt to synthesize what I've observed and learned. Team Topologies gave me a language for things I had already lived. What follows is that framework, grounded in practice.

---

In 1967, computer scientist Melvin Conway published an observation that turned out to be one of the most durable laws in software engineering: organizations that design systems are constrained to produce designs that are copies of their communication structures.

This has been validated over and over in production. When you look at the architecture of a large software system and then look at the org chart of the company that built it, they look the same. If your three backend teams each own a part of the monolith and all share a database, your architecture will have three tightly coupled modules sharing a database. If your frontend team is entirely separate from your backend teams, your APIs will be poorly designed for the UIs they serve.

Conway's Law is not a problem to solve. It's a tool to use. You can apply it in reverse: design your team structure to match the architecture you want. The architecture will follow.

---

## Why Most Microservices Migrations Fail at the Org Level

The technical challenges of moving to microservices are real but solvable. The organizational challenges are where most migrations actually fail.

The pattern is predictable: a company decides to "go microservices." They break the codebase into separate repositories. Each team gets their own service. But the communication patterns don't change. Team A still needs approval from Team B to deploy anything that affects the shared database. Team C still has a handoff process with Team D for any cross-domain feature. The services are technically separate, but the teams are still coupled.

The result is what I call the distributed monolith: the worst of both worlds. You have the operational complexity of microservices with none of the organizational benefits.

Team Topologies, the framework by Matthew Skelton and Manuel Pais, addresses this directly. It provides a vocabulary for team structures that are explicitly designed to reduce coupling — both in the codebase and in the organization.

---

## Visual Overview: The Four Team Types

Before diving into each type, here is the full picture. The arrows are key — they show what flows between teams and in which direction.

```
TEAM TOPOLOGIES — FOUR TYPES
════════════════════════════

                    ┌──────────────────────────────────────────┐
                    │           Platform Team                   │
                    │  (builds the golden paths and IDP)        │
                    └───────────────┬──────────────────────────┘
                        provides    │     provides
                    ┌───────────────┘──────────────────┐
                    │                                  │
         ┌──────────▼───────────┐           ┌──────────▼───────────┐
         │  Stream-Aligned Team  │           │  Stream-Aligned Team  │
         │  (Checkout Flow)      │           │  (User Onboarding)    │
         └──────────────────────┘           └──────────────────────┘
                    ▲                                  ▲
                    │ enables                          │ enables
         ┌──────────┴───────────┐           ┌──────────┴───────────┐
         │  Enabling Team        │           │  Complicated Subsystem│
         │  (Architecture Guild) │           │  (Risk Engine)        │
         └──────────────────────┘           └──────────────────────┘
```

The Platform team is not a support team — it is a product team whose customers are internal engineers. The Enabling team is temporary by design: it closes a capability gap and steps back. The Complicated Subsystem team hides deep expertise behind a simple interface. Stream-Aligned teams are the units that actually deliver value to users.

---

## The Four Team Types

### Stream-Aligned Teams: The Value Delivery Units

A stream-aligned team is end-to-end responsible for a user-facing capability. "End-to-end" means from product definition through code through deployment through on-call support.

```
Stream-Aligned Team: Checkout Flow
- Product Owner: owns the business outcome
- Full-stack developers: frontend + backend
- DevOps engineer: infrastructure and deployment
- Ownership: the entire checkout experience, including its SLO

What this team owns:
- cart-service
- payment-service (checkout-specific)
- checkout-ui
- All associated SLOs and on-call rotations
```

The defining characteristic is outcome ownership, not technology ownership. A stream-aligned team owns a business metric, not a tier in the stack. If the checkout conversion rate drops, this team is responsible.

```java
// This team owns everything needed to deliver the checkout flow
// NOTE: @TeamOwnership and similar annotations below are illustrative —
// they don't exist in a real Java framework. They represent a design intent.
@Service
@TeamOwnership("checkout-team") // 7 people, cross-functional
public class CheckoutService {

    // No handoffs to "the backend team" or "the payment team"
    // This team owns the payment logic for checkout
    public CheckoutResult processCheckout(CheckoutRequest request) {
        return paymentProcessor.process(request);
    }
}
```

### Enabling Teams: The Learning Accelerators

Enabling teams don't build features. They help stream-aligned teams build features better. Their job is to identify capability gaps, introduce practices, and then step back.

A critical distinction: an enabling team doesn't do the work *for* the stream team. It teaches the stream team to do the work themselves. When an enabling team's engagement becomes permanent — when stream teams can't operate without them — it has become a bottleneck, not an enabler.

At Círculo, the Architecture Squad operated this way by design. We'd engage with a squad for four to six weeks — helping them define service boundaries, set up their deployment pipeline, or adopt a pattern — and then we'd leave. The goal was always that the squad could run independently when we were done. The hardest part of that model is resisting the pull to keep helping. When you're the experts, the temptation to stay involved is real.

```java
// Enabling team: Platform Architecture Guild
// @EnablementService is illustrative — represents the team's operating mode
@EnablementService
public class PlatformEnablingService {

    // Provide self-service capabilities — don't do it for them
    public KubernetesNamespace createNamespaceForTeam(String teamName) {
        return kubernetesService.createNamespace(
            teamName,
            defaultSecurityPolicies(),
            defaultResourceLimits(),
            defaultMonitoringConfig()
        );
    }

    // Time-bounded engagements, not permanent support relationships
    public void conductArchitectureReview(String teamName, Duration engagement) {
        // 4-6 week engagement, knowledge transfer, then the team is independent
    }
}
```

### Complicated Subsystem Teams: The Deep Specialists

Some systems require such deep domain expertise that a generalist stream team can't own them. Risk scoring engines, ML inference pipelines, real-time fraud detection — these need specialists.

The key design principle: complicated subsystem teams expose a simple API to stream teams, hiding the complexity. A stream team doesn't need to understand how the risk engine works. It calls `getQuickRiskDecision(customerId, amount)` and gets a decision back.

```java
// The complicated subsystem is complex internally
// @ComplexSubsystem is illustrative — represents team ownership of a deep domain
@ComplexSubsystem
@TeamOwnership("risk-engineering-team")
public class RiskCalculationEngine {

    // Complex internal logic requiring deep expertise
    private RiskScore calculateCreditRisk(
            CustomerProfile profile,
            TransactionHistory history,
            MarketConditions market) {

        double baseScore = calculateBaseRisk(profile);
        double adjustedScore = applyMarketAdjustments(baseScore, market);
        double timeDecayFactor = calculateTimeDecay(history);

        return new RiskScore(
            adjustedScore * timeDecayFactor,
            calculateConfidenceInterval(profile, history)
        );
    }

    // Simple public API for stream teams — they don't need to know the internals
    @PublicAPI
    public RiskDecision getQuickRiskDecision(String customerId, double amount) {
        RiskScore score = calculateCreditRisk(
            customerService.getProfile(customerId),
            transactionService.getHistory(customerId),
            marketService.getCurrentConditions()
        );

        return score.getScore() > RISK_THRESHOLD ? RiskDecision.APPROVE : RiskDecision.DENY;
    }
}
```

### Platform Teams: The Foundation Builders

Platform teams build and operate the internal developer platform — the golden paths that let stream teams be productive without reinventing infrastructure, security, or deployment tooling.

The product mindset is essential here. A platform team's "customers" are the other engineering teams. If stream teams avoid using the platform and build their own infrastructure instead, the platform team has failed — regardless of how sophisticated their platform is.

```yaml
# Internal Developer Platform capabilities
Platform Services:
  CI/CD:
    description: "Golden path deployment pipeline"
    adoption: "self-service via pipeline-as-code template"

  Container Platform:
    description: "Kubernetes with security defaults"
    adoption: "self-service namespace creation"

  Observability:
    description: "Pre-configured Grafana + distributed tracing"
    adoption: "auto-instrumented for Spring Boot services"

  Secret Management:
    description: "Vault integration with automatic rotation"
    adoption: "sidecar injection — zero code changes required"
```

---

## Interaction Modes: The Part Most People Miss

Team types describe *what* a team does. Interaction modes describe *how* teams work together. This distinction is where most implementations of Team Topologies break down — people define team types and stop there, never specifying how teams are supposed to coordinate.

Team Topologies defines three interaction modes:

| Mode | What it means | When to use it | Common mistake |
|---|---|---|---|
| **Collaboration** | Two teams work closely together, sharing code and decisions | Short, intensive periods — spiking on a new domain, cross-team prototyping | Treating collaboration as permanent. When it doesn't end, both teams slow down. |
| **X-as-a-Service** | One team consumes what another provides via a stable API, with minimal coordination | When the interface is well-defined and stable — platform → stream-aligned | Building X-as-a-Service before the contract is stable. High churn in the API creates hidden coupling. |
| **Facilitating** | One team helps another grow a capability, then steps back | Enabling team engaging with a stream-aligned team | The facilitating team never leaves. Enabling becomes dependency. |

The progression matters: teams often start in Collaboration mode while working out the right interface, then shift to X-as-a-Service once the contract stabilizes. Staying in Collaboration too long is the most common failure — it feels productive, but it means both teams are blocked on each other's schedules.

At Círculo, the Architecture Squad operated primarily in Facilitating mode. When we were introducing a new practice (say, distributed tracing or service mesh configuration), we'd briefly enter Collaboration mode with a squad to prototype together. Once patterns were established, we'd document the golden path and move to X-as-a-Service: squads consume the platform, we maintain it.

---

## Conway's Law as a Design Tool: The Inverse

Once you understand the four team types, you can apply Conway's Law intentionally. If you want a modular, independently deployable architecture, design your team structure to match.

**Desired architecture → Team structure that produces it:**

| Architecture Goal | Team Design | Common Mistake |
|---|---|---|
| Independent deployment per domain | One stream-aligned team per domain | One team owning multiple unrelated services — they'll develop shared deploy schedules and hidden coupling |
| Shared security standards | Enabling team for security practices | Putting security inside a platform team — platform enforces, but doesn't teach; teams route around it |
| Consistent observability | Platform team owning the observability stack | Making observability opt-in — adoption stays low, gaps appear in incident response |
| High-complexity domain separation | Complicated subsystem team for that domain | Embedding the specialists inside a stream team — they get pulled into feature work and the expertise diffuses |

The converse is also true and worth internalizing: if you have one team responsible for five microservices across three domains, the services will develop hidden dependencies and shared deployment schedules. The organization shape will impose itself on the architecture.

---

## Cognitive Load: The Hidden Constraint

A concept from Team Topologies that doesn't get enough attention: cognitive load. Every team member can only hold a certain amount of complexity in their head. When a team's cognitive load exceeds this limit, quality drops, velocity drops, and burnout follows.

**Dunbar's Number applied to teams:**
```
Team size for effective communication:
- 5-9 people: Core execution team
- 8-12 people: Squad with autonomy
- 50-150 people: Tribe/department limit

Communication channels = n(n-1)/2
- 5 people  = 10 channels
- 10 people = 45 channels
- 15 people = 105 channels
```

When Brooks' Law says "adding people to a late project makes it later," it's pointing to this: adding people increases communication overhead faster than it increases productive capacity.

The platform team addresses this by reducing cognitive load for stream teams. If a stream team doesn't have to think about Kubernetes networking, certificate rotation, or log aggregation — because the platform handles it — their cognitive budget is free for domain problems.

---

## The IDP as Architecture: What Your Platform Reveals

At Círculo de Crédito, we built an IDP that ran on Kubernetes with golden paths for deployment, observability, and secret injection. One of the clearest lessons from that build: the platform is a mirror. What the platform makes easy, teams will build. What the platform makes hard, teams will avoid or build badly — usually both.

When we added auto-instrumented distributed tracing for HTTP services, adoption was immediate. Engineers didn't have to change a line of application code. When the same capability wasn't yet available for Kafka consumers, those services shipped with no trace context and became black boxes during incidents.

The platform team makes architecture decisions whether it intends to or not. Every golden path is an implicit recommendation. Every gap in the golden paths is a place where teams will diverge.

Assess your platform by asking: what does it make the path of least resistance? That's what your architecture will look like in two years.

If your platform provides a golden path for deploying stateless services but has no path for stateful workloads, you'll have a proliferation of stateless services and a few hand-crafted, inconsistently operated stateful systems. If your platform has built-in distributed tracing for HTTP calls but not for Kafka consumers, your event-driven services will have observability gaps.

---

## The 5 Dysfunctions That Show Up in Your Architecture

Patrick Lencioni's five dysfunctions of a team — absence of trust, fear of conflict, lack of commitment, avoidance of accountability, inattention to results — manifest directly in architecture. I've seen all five in production systems.

- **Absence of trust** produces defensive APIs with excessive validation and no shared contracts. Teams don't trust that the other side won't break them, so they duplicate logic, wrap everything in guards, and avoid building on each other's interfaces. The result is code that looks like a wall — heavily fortified at the boundary, underdeveloped on the inside.

- **Fear of conflict** produces committee-designed architectures that satisfy no one's constraints well. The most technically controversial decision gets deferred, documented as "TBD," and eventually resolved by whoever builds the first implementation. That implementation becomes the de facto architecture.

- **Lack of commitment** produces systems where no team owns the reliability of the whole. Each team is accountable for their service's uptime, but the end-to-end reliability has no owner. In an incident, this becomes visible immediately: everyone can show that their service was fine; no one knows why the user experience failed.

- **Avoidance of accountability** produces systems where incidents are investigated but never resolved. The post-mortem gets written, the action items get opened, and the same failure happens six months later because no one followed through and no one asked why.

- **Inattention to results** produces platforms optimized for engineering metrics (deployments per day) rather than business outcomes (customer satisfaction). A platform team that measures itself by deployment frequency can achieve that number while stream teams are increasingly frustrated with reliability, documentation, and support.

The fix is not purely technical. You can add all the architecture review boards you want, but if the teams don't trust each other, the system design will reflect that. Building trust between teams — specifically, between the platform team and stream teams — is a prerequisite for the platform operating as described.

---

## Where to Start

If you're looking at your current team structure and architecture and seeing the misalignment:

1. **Draw the actual communication map.** Who do your teams actually talk to when they need to ship something? Not the org chart — the real dependency map.
2. **Identify the coupling hotspots.** Which teams need each other to deploy? That coupling is in your architecture too.
3. **Pick one platform investment.** What one thing could the platform team build that would eliminate a recurring coordination overhead for stream teams?
4. **Create one golden path.** Not a mandate — a path of least resistance that teams will naturally choose because it's easier than the alternative.
5. **Define the interaction mode explicitly.** For each team relationship you care about, name it: Collaboration, X-as-a-Service, or Facilitating. If you can't name it, the teams probably can't either.

The architecture you have reflects the organization you have. If you want a different architecture, you need to think seriously about the organization you need.

---

This intersection of organizational design and technical architecture is one of the most underrated leverage points in software engineering. If you're working through these challenges and want to compare approaches, I'm at luceroriosg@gmail.com.
