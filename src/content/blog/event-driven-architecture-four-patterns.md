---
title: "Event-Driven Architecture: The Four Patterns You Actually Need in Production"
description: "A deep dive into Event Sourcing, Pub/Sub, CQRS, and secure event design — with real Java/Spring Boot code for financial-grade systems."
pubDate: 2026-03-29
tags: ["event-driven-architecture", "kafka", "java", "microservices", "distributed-systems"]
draft: false
---

Synchronous architectures fail in two predictable ways at scale: cascading outages when a downstream service is slow or unavailable, and audit gaps that collapse under regulatory scrutiny. Event-driven architecture solves both — but only if you apply the right patterns. Most EDA tutorials stop at Pub/Sub. In production financial systems, that's not enough.

This post covers the four patterns that actually matter in high-compliance, high-throughput environments: Event Sourcing, Pub/Sub, CQRS, and secure event design. Not theory — implementations battle-tested with Spring Boot and Kafka, including the part most tutorials skip: security at the event layer.

---

## Why Events First?

Before the patterns, the *why*. Synchronous request-response architectures create invisible coupling. When Service A calls Service B directly, you've bound their lifecycles together — a B outage becomes an A outage. At scale, this becomes a distributed monolith.

At Findep, credit scoring, disbursement, collections, and fraud detection all needed to react to loan application state changes. Wiring those together with REST calls would have created a dependency graph that made deployments a coordination nightmare. Events let each team own their reaction to what happened, without being coupled to the service that produced it.

Events flip the dependency model. Instead of "call this service," you declare "this thing happened." Consumers decide what to do. The four pillars of a solid EDA:

- **Decoupling** — services communicate only through events, eliminating direct dependencies
- **Scalability** — async processing allows horizontal scaling on demand
- **Resilience** — built-in retry, replay, and recovery
- **Auditability** — a complete, immutable log of every operation

Let's get into the patterns.

---

## Pattern 1: Event Sourcing

In a traditional account system you store the current balance — that's it. If a regulator asks "how did this account get to this balance?" you reconstruct it from logs, audit tables, or whatever your team remembered to add. Event Sourcing makes that reconstruction the primary model. You store the sequence of things that happened, and current state is always derived by replaying them.

```
TRADITIONAL:              EVENT SOURCING:
┌──────────────┐          ┌──────────────────────────────────────┐
│   Account    │          │  Event Log (append-only)             │
│  ──────────  │          │  ────────────────────────────────    │
│  balance:    │          │  1. AccountOpened      (+$0)         │
│  $1,200      │          │  2. DepositMade        (+$1,500)     │
└──────────────┘          │  3. WithdrawalMade     (-$300)       │
  No history              │  → Replay = $1,200                   │
                          └──────────────────────────────────────┘
```

This matters in regulated financial environments because the log is the truth — not a side effect of it. You get tamper-evident history, the ability to replay to any point in time, and a foundation for the CQRS pattern below.

The base event and aggregate classes are deliberately thin. The aggregate collects uncommitted events before they're persisted so you can unit test domain logic without touching a database:

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

The `EventStore` interface is deliberately simple. Behind it you can use PostgreSQL with an `events` table, EventStoreDB, or any append-only store. The interface hides that choice from the domain:

```java
public interface EventStore {
    void appendEvents(String streamId, List<DomainEvent> events);
    List<DomainEvent> getEvents(String streamId, long fromVersion);
}
```

**When to use it:** When you need a full audit trail, when "undo" is a business requirement, or when rebuilding state from scratch needs to be possible (e.g., regulatory replay requests). At Círculo de Crédito, credit bureau data has strict retention and traceability requirements — this pattern fits naturally.

**When to avoid it:** For simple CRUD entities where history has no business value. Event Sourcing adds operational complexity — snapshots, schema evolution, projection rebuilds. Don't use it everywhere.

---

## Pattern 2: Pub/Sub with Kafka

Once a loan application changes state at Findep — approved, disbursed, defaulted — seven different downstream systems need to know: collections, fraud, reporting, customer notifications, the scoring model, the ledger, the CRM. You cannot afford to call all of them synchronously from the originating service. One slow consumer stalls the whole operation.

Pub/Sub decouples that fan-out. The producer publishes one event; each consumer group receives it independently, processes at its own pace, and fails without affecting the others.

```
                  ┌─────────────────────────────────────────────┐
                  │              Kafka Topic                     │
  ┌───────────┐   │  account-events                             │
  │  Account  │──▶│  ─────────────────────────────────────────  │
  │  Service  │   │  [AccountOpened] [DepositMade] [Withdrawn]  │
  └───────────┘   └──────────┬──────────────┬───────────────────┘
                             │              │
              ┌──────────────┘              └──────────────────┐
              ▼                                                 ▼
  ┌──────────────────────┐                       ┌─────────────────────────┐
  │  notification-svc    │                       │  fraud-detection-svc    │
  │  (consumer group A)  │                       │  (consumer group B)     │
  └──────────────────────┘                       └─────────────────────────┘
```

The publisher abstracts Kafka behind a clean interface so the domain code doesn't have to know how events are transported:

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

**Key production consideration:** consumer groups are your scaling unit. Each group gets every message independently. Within a group, Kafka distributes partitions across instances. Design your partition key carefully — it determines ordering guarantees. For financial transactions, partition by account ID so all events for the same account are processed in order by the same consumer instance.

---

## Pattern 3: CQRS

In a high-volume lending system, the write path and the read path have fundamentally different shapes. Writing a loan application event is a narrow operation: validate, append, publish. Querying the loan portfolio for a collections dashboard is the opposite: aggregates, joins, filters across millions of records. If both go through the same model, you end up optimizing for neither.

CQRS separates them entirely. Commands mutate state and produce events. Queries read from projections — denormalized read models built specifically for the query pattern they serve.

```
  WRITE SIDE                              READ SIDE
  ─────────────────────────────           ─────────────────────────────
  Command                                 Query
     │                                       │
     ▼                                       ▼
  Command Handler                         Read Model (projection)
     │                                    (denormalized, query-optimized)
     ▼
  Aggregate → DomainEvent
     │
     ├──▶ EventStore (append)
     │
     └──▶ EventPublisher
               │
               ▼
           Kafka topic
               │
               ▼
         Projection updater ──▶ Read Model
```

The write side produces events and never queries. The read side listens for events and updates its own store. They never share a database table:

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

**The real benefit:** multiple read models for the same event stream, each optimized for a different use case — fast single-record lookup, a search index, a reporting aggregate, a collections queue. None of them affect the write path. At Findep, we had the same transaction event stream feeding separate projections for operations, finance, and regulatory reporting — each one shaped for its consumer.

---

## Pattern 4: Secure Event Design

In regulated industries, events aren't just data — they're evidence. At a credit bureau, an event saying a credit inquiry was made is legally significant. At a lending company, a disbursement event triggers downstream obligations. If those events can be forged, replayed out of order, or read by an unauthorized service, you have a compliance problem that no amount of application-layer access control will fix.

Security belongs at the event layer, not above it.

**Event signing** ensures that any consumer can verify an event was produced by a legitimate service and hasn't been tampered with in transit. The signature travels with the event:

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

**Envelope encryption** protects the payload contents. Even if an attacker gains read access to the Kafka broker — which is a realistic threat model for multi-tenant or cloud-hosted clusters — they cannot read customer data without the decryption key. PII fields in financial events (RFC, CURP, account numbers) should always be encrypted before they leave the originating service:

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

Across all patterns, follow the [CloudEvents spec](https://cloudevents.io/) for a consistent envelope. Every event in the system should look like this:

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
    "currency": "MXN",
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

The idempotency rule is especially important in financial systems. At Findep, a disbursement event being processed twice is not a logging problem — it's a money problem. Every consumer that touches money or credit state needs to track which event IDs it has already processed.

---

## Putting It All Together

These four patterns aren't mutually exclusive. A production financial-grade system uses all of them:

- **Event Sourcing** as the write-side persistence for core aggregates (accounts, loans, payments)
- **Pub/Sub via Kafka** to fan out to downstream services (fraud, collections, notifications, reporting)
- **CQRS** to maintain multiple read-optimized projections without touching the write path
- **Secure event design** as a cross-cutting concern on every publish/consume path

The result is a system that is auditable by design, independently scalable at each consumer, resilient to partial failures, and explainable to compliance teams when they come asking.

---

## What's Next

In future posts I'll go deeper on:

- **Kafka Streams for real-time analytics** — windowed aggregations, stream joins, and state stores
- **Migrating a monolith to EDA incrementally** — the Strangler Fig pattern in practice
- **Observability for event-driven systems** — which metrics actually predict production incidents

If you're building distributed systems and want to compare notes, [reach out](mailto:luceroriosg@gmail.com).
