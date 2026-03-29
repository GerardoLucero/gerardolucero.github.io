---
title: "SOLID in Distributed Systems: Beyond the Textbook"
description: "SOLID principles don't disappear when your classes become microservices — they scale up. Here's how SRP, OCP, LSP, ISP, and DIP re-apply when your unit of deployment is a service."
pubDate: 2026-04-19
tags: ["solid", "java", "microservices", "architecture", "clean-code"]
draft: false
---

Running Architecture Squad reviews at Círculo de Crédito meant sitting with teams and walking through their codebases — not to audit them, but to help them reason about what they'd built. One pattern came up constantly: teams that understood SOLID at the class level were still violating it at the service level. A developer who would never put email logic and audit logic in the same class would nonetheless maintain a monolithic "User Service" that six different teams deployed against. The principles they knew didn't feel relevant at that scale.

They were wrong — and I was in the same room having to explain why.

Here's what I've learned operating distributed systems at scale: SOLID doesn't disappear at the service boundary. It scales up. The same principles apply — but the consequences of violating them are measured in outages, deployment trains, and teams that can't ship independently.

Let me walk through each principle and show how it transforms when the unit of deployment is a service rather than a class.

---

## Quick Reference: SOLID at Class Level vs. Service Level

Before going deep on each principle, here's the full mapping at a glance:

```
SOLID: Class → Service mapping

SRP: One class = one reason to change
  → One service = one business domain

OCP: Extend without modifying
  → New consumers don't require producer changes

LSP: Subtypes must be substitutable
  → New event schema versions must be backward-compatible

ISP: Don't force clients to depend on unused methods
  → CQRS: separate read and write APIs

DIP: Depend on abstractions, not implementations
  → Domain logic must not import Kafka/AWS directly
```

The rest of this article unpacks each one with code examples and the real symptoms to look for.

---

## Single Responsibility Principle: Services With One Reason to Change

**The textbook version:** A class should have one, and only one, reason to change.

**The distributed version:** A service should be owned by one team and serve one domain.

**The violation looks like:** Your "Account Service" handles account opening, KYC status updates, credit limit changes, fraud flags, and account closure — because they all touch the account record. A compliance change, a product change, and a fraud rule update all funnel into the same deployment. Three teams are waiting on each other to release.

This sounds obvious, but in practice it's violated constantly. The classic failure mode is a "User Service" that handles authentication, profile management, preferences, notification settings, audit logging, and session management. Every product team has a reason to change it, which means every team is blocking on every other team.

**The violation at class level:**
```java
// WRONG: Four reasons to change this single class
@Service
public class UserService {
    private final UserRepository userRepository;
    private final EmailClient emailClient;
    private final AuditRepository auditRepository;

    public User createUser(CreateUserRequest request) {
        User user = userRepository.save(new User(request));
        emailClient.send(user.getEmail(), "Welcome!");                         // reason 1: email logic changes
        auditRepository.save(new AuditLog("USER_CREATED", user.getId()));     // reason 2: audit format changes
        return user;
    }
}
```

**The fix — separate responsibilities:**
```java
// Each class has exactly one reason to change
@Service
public class UserService {
    private final UserRepository userRepository;

    public User createUser(CreateUserRequest request) {
        return userRepository.save(new User(request));
    }
}

@Service
public class EmailService {
    private final EmailClient emailClient;

    public void sendWelcomeEmail(User user) {
        emailClient.send(user.getEmail(), "Welcome!");
    }
}

@Service
public class UserAuditService {
    private final AuditRepository auditRepository;

    public void logUserCreation(User user) {
        auditRepository.save(new AuditLog("USER_CREATED", user.getId()));
    }
}
```

At the service level, this translates to: if changing your notifications logic requires redeploying your identity service, your service has too many responsibilities. The question to ask is: "What is the one business capability this service owns?" If you can't answer it in five words, the service is probably doing too much.

**Service-level SRP signal:** If more than one team has commit access to the service's repository, or if the service's changelog mentions multiple domains in the same release, the SRP is being violated.

---

## Open/Closed Principle: Extend Without Modifying

**The textbook version:** Software entities should be open for extension, but closed for modification.

**The distributed version:** Adding a new consumer to your events should not require changes to the producer.

**The violation looks like:** The Transaction Service publishes a `TransactionCompletedEvent`. The Rewards team wants to start listening. They file a ticket to the Transactions team to add a new field. The Transactions team has to plan it, review it, test it, and deploy it — for a feature they don't own. This is happening every sprint, for every new integration.

This is where event-driven architecture becomes the natural implementation of OCP at scale. When your Order Service publishes an `OrderCreatedEvent`, it shouldn't care whether Payments, Inventory, Notifications, and Analytics are all listening. Adding a new consumer doesn't require touching the producer.

**The class-level pattern:**
```java
// Open for extension: add new providers without modifying this class
public interface PaymentProvider {
    PaymentResult processPayment(PaymentRequest request);
}

@Service
public class StripePaymentProvider implements PaymentProvider {
    @Override
    public PaymentResult processPayment(PaymentRequest request) {
        return stripeClient.charge(request);
    }
}

@Service
public class PayPalPaymentProvider implements PaymentProvider {
    @Override
    public PaymentResult processPayment(PaymentRequest request) {
        return paypalClient.process(request);
    }
}

@Service
public class PaymentService {
    private final Map<String, PaymentProvider> providers;

    public PaymentResult processPayment(String provider, PaymentRequest request) {
        // Adding a new provider requires no changes here
        return providers.get(provider).processPayment(request);
    }
}
```

**The service-level consequence:** If adding a new integration requires a code change and redeployment of an existing service, you're violating OCP. The producer is "closed" — it publishes events and doesn't know who's listening. Consumers are "open" — you can add new ones without touching the producer's codebase.

---

## Liskov Substitution Principle: Contracts That Don't Lie

**The textbook version:** Subtypes must be substitutable for their base types without breaking correctness.

**The distributed version:** Different versions of your service API must be backward-compatible. New consumers should work with old events. Old consumers should work with new event schemas.

**The violation looks like:** The Risk team adds a required field `riskScore` to the `LoanApplicationEvent`. The Credit Service, which has been consuming that event for months, starts throwing `NullPointerException` in production after the Risk team deploys. An incident is opened. The deployment is rolled back. The teams spend two days on postmortem. The root cause: the new schema couldn't substitute for the old one.

LSP violations in distributed systems manifest as broken consumers after a producer deployment. If you add a new required field to your event schema and old consumers crash trying to process events that lack that field, you've violated LSP — the new version can't substitute for the old one.

**The class-level implementation:**
```java
// Correct LSP: all subtypes honor the same contract
public abstract class NotificationService {
    public abstract void send(String recipient, String message);
}

@Service
public class EmailNotificationService extends NotificationService {
    @Override
    public void send(String recipient, String message) {
        emailClient.send(recipient, message);
    }
}

@Service
public class SmsNotificationService extends NotificationService {
    @Override
    public void send(String recipient, String message) {
        smsClient.send(recipient, message);
    }
}

// Any NotificationService implementation can substitute for any other
@Service
public class NotificationOrchestrator {
    private final List<NotificationService> services;

    public void notifyAll(String recipient, String message) {
        services.forEach(service -> service.send(recipient, message));
    }
}
```

**The practical rule for event schemas:** Never remove fields. Never change field types. Add new optional fields only. This is the distributed system equivalent of "don't break the contract."

---

## Interface Segregation Principle: Thin Contracts, Focused APIs

**The textbook version:** Clients should not be forced to depend on interfaces they don't use.

**The distributed version:** Your service's API surface should be split by consumer type. A read-heavy analytics consumer should not depend on the same interface as a write-heavy command handler.

**The violation looks like:** The Reporting team queries the Customer Service to generate monthly statements. The Customer Service API is the same one used by the onboarding flow — it exposes `createCustomer`, `updateKyc`, `closeAccount`, and fifteen other write operations. The Reporting team's service now has a dependency on write endpoints it will never call, but their security team flags it in every audit: "why does the reporting service have access to account closure?"

This directly maps to CQRS (Command Query Responsibility Segregation) at the service level — but the ISP insight applies even before you go full CQRS.

**The fat interface problem:**
```java
// WRONG: All clients depend on everything
public interface UserRepository {
    Optional<User> findById(String id);
    List<User> findByEmail(String email);
    User save(User user);
    void delete(String id);
    List<User> search(String query);
    List<User> findByFilters(UserFilters filters);
}

// A service that only queries now depends on write methods it never uses
@Service
public class UserQueryService {
    private final UserRepository repository; // has write access it shouldn't need
}
```

**The fix — segregate by client need:**
```java
// Each interface is shaped for a specific consumer
public interface UserReadRepository {
    Optional<User> findById(String id);
    List<User> findByEmail(String email);
}

public interface UserWriteRepository {
    User save(User user);
    void delete(String id);
}

public interface UserSearchRepository {
    List<User> search(String query);
    List<User> findByFilters(UserFilters filters);
}

@Service
public class UserQueryService {
    private final UserReadRepository readRepository;
    private final UserSearchRepository searchRepository;
    // Cannot accidentally call write methods
}

@Service
public class UserCommandService {
    private final UserWriteRepository writeRepository;
    // Cannot accidentally call read methods
}
```

**At the service level:** If your service's public API has forty endpoints, some consumers use three of them and others use three different ones. Consider whether what you have is one service or several — or at least whether the API contract should be split into a read contract and a write contract.

---

## Dependency Inversion Principle: Depend on What You Control

**The textbook version:** High-level modules should not depend on low-level modules. Both should depend on abstractions.

**The distributed version:** Your domain logic should not depend on infrastructure details — Kafka, PostgreSQL, AWS S3. It should depend on abstractions that the infrastructure implements.

**The violation looks like:** The team wants to migrate from SQS to Kafka for the payment events pipeline. They open the `PaymentService` to make what should be a configuration change — and find `SqsClient` calls scattered across 12 business methods. The migration becomes a two-week refactor. Every method that publishes an event has to be touched, tested, and re-reviewed. The business logic and the infrastructure have fused together.

This is the principle that makes testing possible without a running Kafka cluster, and cloud migration possible without rewriting your domain logic.

**The violation:**
```java
// Domain logic tied to Kafka specifics
@Service
public class UserService {
    private final UserRepository userRepository; // tied to JPA
    private final KafkaTemplate<String, UserEvent> kafkaTemplate; // tied to Kafka

    public User createUser(CreateUserRequest request) {
        User user = userRepository.save(new User(request));
        kafkaTemplate.send("user-events", new UserCreatedEvent(user)); // infrastructure leak
        return user;
    }
}
```

**The correct pattern:**
```java
// Domain logic depends on abstractions
public interface EventPublisher {
    void publish(String topic, DomainEvent event);
}

public interface UserRepository {
    User save(User user);
    Optional<User> findById(String id);
}

@Service
public class UserService {
    private final UserRepository userRepository;       // abstraction
    private final EventPublisher eventPublisher;       // abstraction

    public UserService(UserRepository userRepository, EventPublisher eventPublisher) {
        this.userRepository = userRepository;
        this.eventPublisher = eventPublisher;
    }

    public User createUser(CreateUserRequest request) {
        User user = userRepository.save(new User(request));
        eventPublisher.publish("user-events", new UserCreatedEvent(user));
        return user;
    }
}

// Infrastructure implementations — swappable without touching domain
@Repository
public class JpaUserRepository implements UserRepository {
    // JPA-specific implementation
}

@Component
public class KafkaEventPublisher implements EventPublisher {
    @Autowired
    private KafkaTemplate<String, DomainEvent> kafkaTemplate;

    @Override
    public void publish(String topic, DomainEvent event) {
        kafkaTemplate.send(topic, event);
    }
}
```

**The DIP payoff:** Your domain logic can now be unit-tested with mocks. Your infrastructure can be swapped — from SQS to Kafka, from PostgreSQL to DynamoDB — without touching business logic. And onboarding new engineers is faster because the domain model doesn't require understanding the entire infrastructure stack to reason about.

---

## The SOLID Microservices Checklist

A quick diagnostic to assess how well your services follow these principles:

| Principle | Service-Level Signal | Violation Indicator | Fix |
|---|---|---|---|
| SRP | One team owns the service | Multiple teams commit to the same repo | Split service by domain; establish clear ownership |
| OCP | Adding consumers requires no producer changes | New integrations require producer redeployment | Move to event-driven; consumers subscribe independently |
| LSP | Event schemas are backward-compatible | Consumer failures after producer deployment | Add fields as optional; never remove or retype fields |
| ISP | API split by consumer type | 40-endpoint services where each client uses 5 | Separate read and write APIs; consider CQRS |
| DIP | Domain logic has no import statements for AWS/Kafka | Infrastructure classes mixed into business logic | Introduce abstraction interfaces; inject implementations |

SOLID scales. The principles that apply at the class level apply at the service level — the blast radius is just larger when you get them wrong.

---

Building clean, maintainable distributed systems is harder than it looks on a whiteboard. If you're working through these tradeoffs and want to compare notes, I'm at luceroriosg@gmail.com.
