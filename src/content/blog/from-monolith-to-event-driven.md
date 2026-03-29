---
title: "From Monolith to Event-Driven: A Migration Playbook"
description: "Migrating from a monolith to event-driven microservices without a big-bang rewrite. The Strangler Fig pattern in practice, with incremental steps and real decision criteria."
pubDate: 2026-05-03
tags: ["event-driven-architecture", "migration", "microservices", "kafka", "architecture"]
draft: false
---

I've been through this twice in very different contexts — and the pain is real both times.

At Petco México, I was coordinating three squads across a system that touched over 100 stores. The monolith wasn't just a technical problem; it was a coordination problem. A schema change to support a new store format required sign-off across teams that barely shared a sprint board. Deployments became ceremonies. Incidents that originated in one bounded context cascaded into unrelated domains because everything ran in the same process.

At Círculo de Crédito, as part of the Architecture Squad, the stakes were different — a credit bureau system where correctness and regulatory traceability were non-negotiable. There, the monolith's temporal coupling was the killer. A slow downstream call during a credit inquiry could block an entire transaction chain. Extracting payment and notification flows into event-driven services wasn't a trend we were chasing; it was a structural requirement to meet SLAs.

Both experiences taught me the same thing: **the most dangerous words in software architecture are "we'll rewrite it."** The big-bang rewrite freezes the existing system, creates parallel maintenance burden, and delivers nothing to users for months or years while the team reimplements functionality that already works.

There's a better way: the Strangler Fig pattern, named after the strangler fig tree that grows around an existing tree until it eventually replaces it. You extract capabilities incrementally, domain by domain, while the existing system keeps running. The monolith shrinks; the event-driven architecture grows. Eventually, the monolith is gone — but users never experienced a migration.

This is a playbook for how to do that in practice.

---

## Why the Monolith Breaks Under Load

Before the migration strategy, understand what actually breaks in a monolith at scale. It's not usually throughput — many monoliths handle impressive load. What breaks is:

**Deployment coupling.** A bug in the notifications module forces a full deployment that includes the payment module. A schema change for reporting requires coordination across every team. Deployment frequency plummets because every release is a coordinated event. At Petco, this was the most visible symptom: a change to how store promotions were applied could delay a fix to the checkout flow by a week.

**Temporal coupling.** All operations happen in a single transaction. A slow inventory check blocks the payment confirmation. A third-party payment gateway that hangs takes down the entire checkout flow — including features that have nothing to do with payments.

**Scaling inefficiency.** You can't scale the checkout flow without scaling the admin panel. Resources are wasted, and the bottleneck module limits the performance of everything else. In e-commerce, Black Friday traffic to the order service shouldn't force you to scale your reporting module.

**Organizational coupling.** As the system grows, so does the team. But a single codebase creates coordination overhead that grows with team size. Brooks' Law kicks in, and adding engineers makes things slower.

The event-driven migration is fundamentally a decoupling exercise. You're not just changing the technical architecture — you're creating deployment independence, temporal independence, and organizational independence.

---

## The Strangler Fig Pattern — Visualized

Before explaining the mechanics, here's the shape of the migration. Most teams underestimate how incremental this is:

```
STRANGLER FIG MIGRATION PATTERN
═══════════════════════════════

Phase 1: Monolith + events in parallel
┌─────────────────────────────────────┐
│           MONOLITH                  │         ┌──────────────┐
│  Orders ──► Payments ──► Inventory  │──events─► New Service  │
│                                     │         │ (shadow mode)│
└─────────────────────────────────────┘         └──────────────┘

The monolith keeps running unchanged. A new service is built to consume
the events it now publishes — but it doesn't handle real traffic yet.
This is the shadow mode phase: validate correctness before routing traffic.

Phase 2: Route traffic to new service
┌────────────────────────┐    ┌──────────────────────────────┐
│  MONOLITH (shrinking)  │    │  NEW SERVICES (growing)       │
│  [Orders] [Inventory]  │    │  [Payments] ──► Kafka ──►    │
│                        │    │  [Notifications]              │
└────────────────────────┘    └──────────────────────────────┘

Traffic is routed to the new service via API gateway or feature flag.
The monolith still exists but no longer owns the extracted domain.
Both run in parallel during the stabilization window.

Phase 3: Monolith is gone
                              ┌──────────────────────────────┐
                              │  EVENT-DRIVEN ARCHITECTURE   │
                              │  [Orders] [Payments]         │
                              │  [Inventory] [Notifications] │
                              └──────────────────────────────┘

The monolith has been fully strangled. Each domain is an independent
service, communicating through events. No downtime, no big bang.
```

The key insight: at no point do users experience a migration. The system is always running.

---

## Migration Anti-Patterns: What Teams Do Wrong

Before the playbook, a catalog of the mistakes I've seen (and made). Most failed migrations fail for one of these reasons:

**Anti-pattern 1: The Big-Bang Rewrite.**
The team decides the monolith is too entangled to extract incrementally, so they rebuild from scratch in parallel. Six months in, the new system is at 60% feature parity, the monolith is still getting bug fixes, and now you're maintaining two systems. This almost never ends well. The Strangler Fig exists specifically to avoid this.

**Anti-pattern 2: Extracting the Shared Database Module First.**
The database is the most entangled part of any monolith. It's also the most tempting extraction target because "the real problem is the shared schema." Resist this. Extract domain services first and let them own their data. Shared database extraction is a consequence of domain extraction, not a prerequisite.

**Anti-pattern 3: No Shadow Mode.**
Teams skip the parallel-run phase because it feels wasteful — you're running the same logic twice. This is the most expensive shortcut in migrations. Shadow mode is where you discover the edge cases: the 3 a.m. batch job that the new service doesn't handle, the Brazilian Real currency formatting that only fails in production, the retry behavior that creates duplicate orders. Shadow mode catches these before users see them.

**Anti-pattern 4: Synchronous HTTP Between New Service and Monolith.**
You extracted a service, but it still calls the monolith synchronously via REST. You've now created a distributed monolith — you have the operational complexity of microservices with none of the decoupling benefits. The event bus must come before the first extraction.

**Anti-pattern 5: Migrating Without Team Readiness.**
A team that hasn't operated a production service before will struggle with "you build it, you run it." Extracting a service and handing it to a team that doesn't understand on-call rotations, runbooks, or SLA ownership is setting up the migration to fail at the organizational layer even if it succeeds technically.

---

## How to Pick Your First Extraction Candidate

This is the most practical decision in the entire migration. Picking wrong creates friction that can derail the whole effort. Here's the decision framework:

**Evaluate each candidate module on these criteria:**

| Criterion | What to look for |
|---|---|
| Domain clarity | Does the module have a clear, self-contained domain? Can you explain what it does in one sentence without referencing other modules? |
| Data ownership | Does the module own its primary data, or does it share tables with 3 other modules? Shared-table modules are expensive to extract. |
| Scaling motivation | Does this module need to scale differently from the rest? (e.g., a high-throughput event ingestion service vs. a low-traffic admin panel) |
| Team motivation | Is there a team that wants to own this service? Voluntary ownership beats assigned ownership. |
| Failure isolation value | If this module fails, does it take down unrelated features? High yes = high extraction value. |
| Call-in count | How many other modules call into this one? Low call-in count = easier extraction. |

**Practical heuristics:**

- In e-commerce: Notifications is almost always the right first extraction. It has a clear domain, it's called by everything but calls nothing critical in return, and teams feel the pain of notification failures leaking into checkout flows.
- In financial systems: Audit/event logging is often the right first extraction. It needs to be reliable, it has a clear schema, and extracting it forces you to introduce the event bus — which sets up everything else.
- Avoid: Anything that touches the core entity (Order in e-commerce, Loan Application in credit). Extract the periphery first. The core is last.

**Red flags that disqualify a candidate:**
- More than 5 other modules import its internal classes
- Its database tables are also written to by other modules
- Its behavior is undocumented and the original author is unavailable
- The team that would own it doesn't want to

---

## Phase 1: Identify the Strangling Points

Not every module is a good extraction candidate. Start by mapping the coupling surface:

**High-value extraction candidates:**
- Modules with their own clear domain model (Orders, Payments, Notifications)
- Modules that need to scale differently from the rest (high-throughput ingestion vs. low-traffic admin)
- Modules where the current implementation is actively slowing the team down
- Modules owned by a team that's ready to operate microservices

**Bad extraction candidates:**
- Core domain entities that everything depends on (extract these last, or never)
- Modules that share state with five other modules
- Modules that are already simple and working fine

The goal is to pick a module where extraction is both technically feasible and organizationally motivated. A reluctant team that doesn't want to own their service's infrastructure will undermine the migration.

---

## Phase 2: Introduce the Event Bus Before Extracting Anything

This is the step most migration guides skip. Before you extract a single service, introduce Kafka into the monolith. Start publishing events from within the monolith itself.

Why? Because events become the connective tissue of your new architecture. If you extract a service before you have events, you end up with synchronous HTTP calls between the new service and the monolith — which recreates the coupling in a distributed form.

**Introduce an event publisher in the monolith:**
```java
// This lives in the monolith, early in the migration
public interface EventPublisher {
    void publish(String topic, DomainEvent event);
}

@Component
public class KafkaEventPublisher implements EventPublisher {

    @Autowired
    private StreamBridge streamBridge;

    @Override
    public void publish(String topic, DomainEvent event) {
        streamBridge.send(topic, event);
    }
}
```

**Start emitting events alongside the existing synchronous flow:**
```java
// In the monolith — we're not removing anything yet.
// This is an e-commerce checkout flow: order creation triggers
// payment processing and inventory reservation synchronously,
// but now also emits an event for future async consumers.
@Service
public class OrderService {

    @Autowired
    private EventPublisher eventPublisher;  // NEW

    public Order createOrder(CreateOrderRequest request) {
        Order order = new Order(request);
        orderRepository.save(order);

        // Existing synchronous calls remain unchanged
        paymentService.processPayment(order);          // e.g. charge credit card
        inventoryService.reserveItems(order);          // e.g. reserve SKUs in warehouse

        // NEW: also publish an event — the Notifications service will
        // eventually consume this instead of being called synchronously
        eventPublisher.publish("order-events",
            new OrderCreatedEvent(
                order.getId(),
                order.getCustomerId(),
                order.getTotalAmount(),
                order.getCurrency()    // important for financial systems: MXN, USD, etc.
            ));

        return order;
    }
}
```

Now you have a parallel event stream running alongside your synchronous monolith. New services can be built to consume these events without touching the monolith.

---

## Phase 3: The Strangler Fig Extraction

With events flowing, you can extract the first service. The pattern is:

1. Build the new service to consume events from Kafka
2. Run it in parallel with the monolith (shadow mode)
3. Validate that the new service produces correct outcomes
4. Route new traffic to the new service (via API gateway or feature flag)
5. Drain and decommission the monolith's version

**The event-driven domain event structure (CloudEvents standard):**
```java
// Domain event — the contract between producer and consumers.
// In a financial system (e.g. credit bureau), the aggregate might be
// a CreditInquiry. In e-commerce, it might be an Order or Payment.
public abstract class DomainEvent {
    private String id;
    private String aggregateId;
    private long version;
    private String eventType;
    private Map<String, Object> data;
    private EventMetadata metadata;

    public DomainEvent(String aggregateId, String eventType, Map<String, Object> data) {
        this.id = UUID.randomUUID().toString();
        this.aggregateId = aggregateId;
        this.eventType = eventType;
        this.data = data;
        this.metadata = new EventMetadata();
    }
}

// Aggregate that raises events
public abstract class Aggregate {
    private List<DomainEvent> uncommittedEvents = new ArrayList<>();
    private long version = 0;

    protected void apply(DomainEvent event) {
        uncommittedEvents.add(event);
        version++;
    }

    public List<DomainEvent> getUncommittedEvents() {
        return new ArrayList<>(uncommittedEvents);
    }

    public void markEventsAsCommitted() {
        uncommittedEvents.clear();
    }
}
```

---

## Phase 4: CQRS for Migrated Domains

Once a domain is extracted, you can take advantage of CQRS to separate read models from write models. This is particularly valuable when the monolith had complex reporting queries mixed into the same database as transactional operations — a pattern I saw frequently in financial systems where the same tables served both real-time transaction processing and end-of-day regulatory reports.

```java
// Command side: write model, handles mutations.
// In a credit context, this might be CreateCreditInquiryCommand.
// In e-commerce, CreateOrderCommand or ProcessPaymentCommand.
@Service
public class CreateUserCommandHandler {

    @Autowired
    private EventStore eventStore;

    @Autowired
    private EventPublisher eventPublisher;

    public void handle(CreateUserCommand command) {
        User user = User.create(
            UUID.randomUUID().toString(),
            command.getEmail(),
            command.getName()
        );

        eventStore.appendEvents("user-" + user.getId(), user.getUncommittedEvents());

        for (DomainEvent event : user.getUncommittedEvents()) {
            eventPublisher.publish("user-events", event);
        }

        user.markEventsAsCommitted();
    }
}

// Query side: read model, optimized for reads.
// Each downstream consumer (dashboard, report, regulatory feed)
// can maintain its own projection without touching the write model.
@Service
public class GetUserQueryHandler {

    @Autowired
    private UserReadModel userReadModel;

    public UserDTO handle(GetUserQuery query) {
        return userReadModel.findById(query.getUserId());
    }
}

// Read model maintained by consuming events
@Repository
public class UserReadModel {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    public UserDTO findById(String id) {
        String sql = "SELECT * FROM users WHERE id = ?";
        return jdbcTemplate.queryForObject(sql, new Object[]{id}, this::mapToUserDTO);
    }

    @EventListener
    public void updateFromEvent(DomainEvent event) {
        switch (event.getEventType()) {
            case "UserCreated":
                handleUserCreated(event);
                break;
            case "UserActivated":
                handleUserActivated(event);
                break;
        }
    }
}
```

The read model is rebuilt from events. If you need a new query shape — a new store performance dashboard, a new regulatory report format, a new fraud detection feed — you add a new projection without changing the write model or the event schema. This was exactly what made CQRS worth the investment at scale: read models become cheap to add.

---

## Phase 5: Decommissioning the Monolith Module

Once the new service has been running in production for a few weeks with proven reliability, you can start decommissioning the monolith's version. The sequence:

1. Stop new traffic from reaching the monolith module (API gateway routing)
2. Verify that no in-flight operations are pending
3. Remove the synchronous call from the monolith
4. Monitor the system for 48-72 hours under production load
5. Remove the dead code from the monolith

**The critical step most teams miss:** don't delete the event publishing code. Even after the monolith module is decommissioned, the events it was publishing may be consumed by systems you don't control — third-party integrations, analytics pipelines, compliance feeds. Keep publishing events from wherever makes sense — either the new service or a migration proxy. Removing an event topic without auditing all consumers first is one of the most disruptive things you can do in an event-driven system.

---

## The Incremental Migration Checklist

| Phase | Action | Success Criterion |
|---|---|---|
| 0 | Introduce event bus | Events flowing from monolith without breaking anything |
| 1 | Identify extraction candidate | Team aligned, domain boundaries clear |
| 2 | Build shadow service | Shadow service produces same results as monolith |
| 3 | Parallel run | 100% traffic to new service, monolith as fallback |
| 4 | Decommission | Monolith module removed, no rollback in 30 days |

Resist the pressure to accelerate this timeline. The "30-day no rollback" criterion before decommissioning is not conservative — it's the minimum viable confidence interval for production systems. In high-volume e-commerce, 30 days catches end-of-month billing cycles. In financial systems, it catches the monthly regulatory batch runs that only fail once per month.

---

## What Makes This Hard

The technical implementation is the easy part. What makes the migration hard:

**Schema evolution.** Once consumers depend on your event schema, changing it requires backward-compatible evolution. Add fields; never remove them. Version your event types. At Círculo de Crédito, where downstream consumers included regulatory systems, breaking a schema was not a "fix it Monday" problem — it was a compliance incident.

**Team readiness.** A team that hasn't operated a production service before will struggle with the "you build it, you run it" model. Invest in enabling work before extraction. At Petco, we spent two sprints on runbooks, alerting setup, and on-call shadowing before a squad took ownership of their first extracted service. That investment paid for itself in the first incident.

**Testing the seam.** Integration tests for the Strangler Fig boundary — where the monolith hands off to the new service — are surprisingly hard to write. Invest in contract testing (Pact or similar) early. The shadow mode phase is also your best opportunity to build confidence: if the shadow service produces the same results as the monolith across 2 weeks of real production traffic, that's stronger evidence than any test suite.

The Strangler Fig pattern is not glamorous. It's methodical, it's slow, and it requires discipline to resist adding scope. But it delivers working software to users throughout the migration — and that's the only thing that actually matters.

---

If you're navigating a monolith-to-microservices migration and want to compare notes on what's worked and what hasn't, I'm at luceroriosg@gmail.com.
