---
title: "Event-Driven Architecture: The Four Patterns You Actually Need in Production"
description: "A deep dive into Event Sourcing, Pub/Sub, CQRS, and secure event design — with real Java/Spring Boot code for financial-grade systems."
pubDate: 2026-03-29
tags: ["event-driven-architecture", "kafka", "java", "microservices", "distributed-systems"]
draft: false
---

Most articles about Event-Driven Architecture (EDA) stop at the whiteboard. They explain the concept, draw some boxes with arrows, and leave you to figure out the implementation. This post is different.

After designing and operating event-driven systems at scale in high-compliance, high-throughput financial environments, I want to share the four patterns that actually matter — not as theory, but as production-tested implementations with Spring Boot and Kafka. I'll also cover the part most tutorials skip: security at the event layer.

---

## Why Events First?

Before the patterns, the *why*. Synchronous request-response architectures create invisible coupling. When Service A calls Service B directly, you've bound their lifecycles together — a B outage becomes an A outage. At scale, this becomes a distributed monolith.

Events flip this. Instead of "call this service," you declare "this thing happened." Consumers decide what to do. The four pillars of a solid EDA:

- **Decoupling** — services communicate only through events, eliminating direct dependencies
- **Scalability** — async processing allows horizontal scaling on demand
- **Resilience** — built-in retry, replay, and recovery
- **Auditability** — a complete, immutable log of every operation

Let's get into the patterns.

---

## Pattern 1: Event Sourcing

Event Sourcing stores the *state changes* of an entity as an append-only sequence of events, rather than the current state. Your database is a log. You reconstruct current state by replaying that log.

This is powerful for audit-heavy domains (finance, compliance, healthcare) because you get a built-in, tamper-evident history of every mutation.

```java
// Base class for all domain events
public abstract class DomainEvent {
    private final String id;
    private final String aggregateId;
    private long version;
    private final String eventType;
    private final Map<String, Object> data;
    private final EventMetadata metadata;

    public DomainEvent(String aggregateId, String eventType, Map<String, Object> data) {
        this.id = UUID.randomUUID().toString();
        this.aggregateId = aggregateId;
        this.eventType = eventType;
        this.data = data;
        this.metadata = new EventMetadata();
    }
}

// Aggregate base — collects uncommitted events before persistence
public abstract class Aggregate {
    private final List<DomainEvent> uncommittedEvents = new ArrayList<>();
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

// Domain entity using Event Sourcing
public class Account extends Aggregate {
    private String id;
    private String ownerId;
    private boolean active = false;

    public static Account open(String id, String ownerId) {
        Account account = new Account(id);
        account.apply(new AccountOpenedEvent(id, ownerId));
        return account;
    }

    public void activate() {
        if (active) throw new IllegalStateException("Account is already active");
        apply(new AccountActivatedEvent(id));
    }
}
```

The `EventStore` interface is deliberately simple:

```java
public interface EventStore {
    void appendEvents(String streamId, List<DomainEvent> events);
    List<DomainEvent> getEvents(String streamId, long fromVersion);
}
```

**When to use it:** When you need a full audit trail, when "undo" is a business requirement, or when rebuilding state from scratch needs to be possible (e.g., regulatory replay requests).

**When to avoid it:** For simple CRUD entities where history has no business value. Event Sourcing adds operational complexity — snapshots, schema evolution, projection rebuilds. Don't use it everywhere.

---

## Pattern 2: Pub/Sub with Kafka

Pub/Sub is the workhorse of EDA. A producer publishes to a Kafka topic. Multiple consumer groups subscribe independently, each getting a full copy of every message.

```java
// Publisher — abstracts Kafka behind a clean interface
@Component
public class KafkaEventPublisher implements EventPublisher {

    @Autowired
    private StreamBridge streamBridge;

    @Override
    public void publish(String topic, DomainEvent event) {
        streamBridge.send(topic, event);
    }
}

// Consumer — handles multiple event types from a single topic
@Component
public class AccountEventConsumer {

    @StreamListener("account-events")
    public void handleAccountEvent(DomainEvent event) {
        switch (event.getEventType()) {
            case "AccountOpened"    -> handleAccountOpened(event);
            case "AccountActivated" -> handleAccountActivated(event);
        }
    }

    private void handleAccountOpened(DomainEvent event) {
        String ownerId = (String) event.getData().get("ownerId");
        notificationService.sendWelcomeNotification(ownerId);
    }
}
```

```yaml
spring:
  cloud:
    stream:
      kafka:
        binder:
          brokers: localhost:9092
          required-acks: 1
      bindings:
        account-events-out:
          destination: account-events
          contentType: application/json
        account-events-in:
          destination: account-events
          group: notification-service-consumer-group
          contentType: application/json
```

**Key production consideration:** consumer groups are your scaling unit. Each group gets every message independently. Within a group, Kafka distributes partitions across instances. Design your partition key carefully — it determines ordering guarantees.

---

## Pattern 3: CQRS

CQRS separates the write path (commands) from the read path (queries). Writes go through aggregates and event sourcing; reads come from denormalized projections optimized for query patterns.

```java
// Command — a request to change state
public record CreateTransactionCommand(
    String accountId,
    BigDecimal amount,
    String currency
) {}

// Command handler — produces events, never queries
@Service
public class CreateTransactionCommandHandler {

    @Autowired private EventStore eventStore;
    @Autowired private EventPublisher eventPublisher;

    public void handle(CreateTransactionCommand command) {
        Transaction tx = Transaction.create(
            UUID.randomUUID().toString(),
            command.accountId(),
            command.amount(),
            command.currency()
        );

        eventStore.appendEvents("tx-" + tx.getId(), tx.getUncommittedEvents());
        tx.getUncommittedEvents().forEach(e -> eventPublisher.publish("transaction-events", e));
        tx.markEventsAsCommitted();
    }
}

// Read model — updated by events, optimized for queries
@Repository
public class TransactionReadModel {

    @Autowired private JdbcTemplate jdbcTemplate;

    public TransactionDTO findById(String id) {
        return jdbcTemplate.queryForObject(
            "SELECT * FROM transaction_projections WHERE id = ?",
            new Object[]{id},
            this::mapToDTO
        );
    }

    @EventListener
    public void updateFromEvent(DomainEvent event) {
        if ("TransactionCreated".equals(event.getEventType())) {
            jdbcTemplate.update(
                "INSERT INTO transaction_projections (id, account_id, amount, currency, created_at) VALUES (?, ?, ?, ?, ?)",
                event.getAggregateId(),
                event.getData().get("accountId"),
                event.getData().get("amount"),
                event.getData().get("currency"),
                event.getMetadata().getTimestamp()
            );
        }
    }
}
```

**The real benefit:** multiple read models for the same event stream, each optimized for a different use case — fast lookup, search index, reporting aggregate. None of them affect the write path.

---

## Pattern 4: Secure Event Design

In regulated industries, events aren't just data — they're evidence. Security at the event layer is non-negotiable.

**Event signing** — every published event carries a cryptographic signature. Consumers verify it before processing:

```java
@Component
public class AuthenticatedEventPublisher implements EventPublisher {

    @Autowired private EventPublisher delegate;
    @Autowired private AuthService authService;

    @Override
    public void publish(String topic, DomainEvent event) {
        String signature = authService.signEvent(event);
        event.getMetadata().setSignature(signature);
        delegate.publish(topic, event);
    }
}
```

**Envelope encryption** — for PII or sensitive financial data, encrypt the payload before publishing. Even if someone gains read access to the broker, the payload is useless without the decryption key:

```java
@Component
public class EncryptedEventPublisher implements EventPublisher {

    @Autowired private KafkaEventPublisher kafkaPublisher;
    @Autowired private EncryptionService encryptionService;

    @Override
    public void publish(String topic, DomainEvent event) {
        String encryptedPayload = encryptionService.encrypt(event);
        DomainEvent wrapper = new DomainEvent(
            event.getAggregateId(),
            event.getEventType(),
            Map.of("encryptedData", encryptedPayload)
        );
        kafkaPublisher.publish(topic, wrapper);
    }
}
```

---

## The Event Schema Contract

Across all patterns, follow the [CloudEvents spec](https://cloudevents.io/) for a consistent envelope:

```json
{
  "specversion": "1.0",
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "source": "/services/account-service",
  "type": "com.example.account.opened",
  "time": "2026-03-29T10:30:00Z",
  "datacontenttype": "application/json",
  "data": {
    "accountId": "acc-123",
    "ownerId": "user-456",
    "currency": "USD",
    "metadata": {
      "version": "1.0",
      "correlationId": "corr-789",
      "causationId": "cmd-012"
    }
  }
}
```

Five rules I enforce in every production system:

1. **Events are immutable** — once published, never modify
2. **Semantic versioning** — breaking changes require a new event type, not a field rename
3. **Minimal payload** — events signal that something happened; they are not DTOs
4. **Idempotent consumers** — design every handler to be safely re-entrant
5. **Dead letter queues** — every consumer needs a DLQ and a retry policy

---

## Putting It All Together

These four patterns aren't mutually exclusive. A production financial-grade system uses all of them:

- **Event Sourcing** as the write-side persistence for core aggregates
- **Pub/Sub via Kafka** to fan out to downstream services
- **CQRS** to maintain multiple read-optimized projections
- **Secure event design** as a cross-cutting concern on every publish/consume path

The result is a system that is auditable by design, independently scalable at each consumer, resilient to partial failures, and explainable to compliance teams.

---

## What's Next

In future posts I'll go deeper on:

- **Kafka Streams for real-time analytics** — windowed aggregations, stream joins, and state stores
- **Migrating a monolith to EDA incrementally** — the Strangler Fig pattern in practice
- **Observability for event-driven systems** — which metrics actually predict production incidents

If you're building distributed systems and want to compare notes, [reach out](mailto:luceroriosg@gmail.com).
