---
title: "From Monolith to Event-Driven: A Migration Playbook"
description: "Migrating from a monolith to event-driven microservices without a big-bang rewrite. The Strangler Fig pattern in practice, with incremental steps and real decision criteria."
pubDate: 2026-05-03
tags: ["event-driven-architecture", "migration", "microservices", "kafka", "architecture"]
draft: false
---

The most dangerous words in software architecture are "we'll rewrite it." The big-bang rewrite is almost always the wrong approach — it freezes the existing system, creates parallel maintenance burden, and delivers nothing to users for months or years while the team reimplements functionality that already works.

There's a better way: the Strangler Fig pattern, named after the strangler fig tree that grows around an existing tree until it eventually replaces it. You extract capabilities incrementally, domain by domain, while the existing system keeps running. The monolith shrinks; the event-driven architecture grows. Eventually, the monolith is gone — but users never experienced a migration.

This is a playbook for how to do that in practice, based on working through this pattern in production systems where downtime was not an option.

---

## Why the Monolith Breaks Under Load

Before the migration strategy, understand what actually breaks in a monolith at scale. It's not usually throughput — many monoliths handle impressive load. What breaks is:

**Deployment coupling.** A bug in the notifications module forces a full deployment that includes the payment module. A schema change for reporting requires coordination across every team. Deployment frequency plummets because every release is a coordinated event.

**Temporal coupling.** All operations happen in a single transaction. A slow inventory check blocks the payment confirmation. A third-party API that hangs takes down the entire checkout flow.

**Scaling inefficiency.** You can't scale the checkout flow without scaling the admin panel. Resources are wasted, and the bottleneck module limits the performance of everything else.

**Organizational coupling.** As the system grows, so does the team. But a single codebase creates coordination overhead that grows with team size. Brooks' Law kicks in, and adding engineers makes things slower.

The event-driven migration is fundamentally a decoupling exercise. You're not just changing the technical architecture — you're creating deployment independence, temporal independence, and organizational independence.

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
// In the monolith — we're not removing anything yet
@Service
public class OrderService {

    @Autowired
    private EventPublisher eventPublisher;  // NEW

    public Order createOrder(CreateOrderRequest request) {
        Order order = new Order(request);
        orderRepository.save(order);

        // Existing synchronous calls remain unchanged
        paymentService.processPayment(order);
        inventoryService.reserveItems(order);

        // NEW: also publish an event — future services will listen here
        eventPublisher.publish("order-events",
            new OrderCreatedEvent(order.getId(), order.getCustomerId(), order.getTotalAmount()));

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
// Domain event — the contract between producer and consumers
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

Once a domain is extracted, you can take advantage of CQRS to separate read models from write models. This is particularly valuable when the monolith had complex reporting queries mixed into the same database as transactional operations.

```java
// Command side: write model, handles mutations
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

// Query side: read model, optimized for reads
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

The read model is rebuilt from events. If you need a new query shape — a new dashboard, a new report format — you add a new projection without changing the write model or the event schema.

---

## Phase 5: Decommissioning the Monolith Module

Once the new service has been running in production for a few weeks with proven reliability, you can start decommissioning the monolith's version. The sequence:

1. Stop new traffic from reaching the monolith module (API gateway routing)
2. Verify that no in-flight operations are pending
3. Remove the synchronous call from the monolith
4. Monitor the system for 48-72 hours under production load
5. Remove the dead code from the monolith

**The critical step most teams miss:** don't delete the event publishing code. Even after the monolith module is decommissioned, the events it was publishing may be consumed by systems you don't control. Keep publishing events from wherever makes sense — either the new service or a migration proxy.

---

## The Incremental Migration Checklist

| Phase | Action | Success Criterion |
|---|---|---|
| 0 | Introduce event bus | Events flowing from monolith without breaking anything |
| 1 | Identify extraction candidate | Team aligned, domain boundaries clear |
| 2 | Build shadow service | Shadow service produces same results as monolith |
| 3 | Parallel run | 100% traffic to new service, monolith as fallback |
| 4 | Decommission | Monolith module removed, no rollback in 30 days |

Resist the pressure to accelerate this timeline. The "30-day no rollback" criterion before decommissioning is not conservative — it's the minimum viable confidence interval for production systems.

---

## What Makes This Hard

The technical implementation is the easy part. What makes the migration hard:

**Schema evolution.** Once consumers depend on your event schema, changing it requires backward-compatible evolution. Add fields; never remove them. Version your event types.

**Team readiness.** A team that hasn't operated a production service before will struggle with the "you build it, you run it" model. Invest in enabling work before extraction.

**Testing the seam.** Integration tests for the Strangler Fig boundary — where the monolith hands off to the new service — are surprisingly hard to write. Invest in contract testing (Pact or similar) early.

The Strangler Fig pattern is not glamorous. It's methodical, it's slow, and it requires discipline to resist adding scope. But it delivers working software to users throughout the migration — and that's the only thing that actually matters.

---

If you're navigating a monolith-to-microservices migration and want to compare notes on what's worked and what hasn't, I'm at luceroriosg@gmail.com.
