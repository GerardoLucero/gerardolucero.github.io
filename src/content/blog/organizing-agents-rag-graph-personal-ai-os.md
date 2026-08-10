---
title: "Building an AI Chief of Staff: Agents, RAG, and a Routing Graph That Knows When to Ask"
description: "AI Chief of Staff tools are a known category now — mostly single-agent, professional-only, closed. Here's the architecture pattern behind a different version: domain agents, a hybrid RAG memory layer, and an explicit graph that decides when the system can act alone vs. when it must stop and ask."
pubDatetime: 2026-08-11T00:00:00Z
draft: true
tags: ["ai-agents", "architecture", "rag", "platform-engineering", "claude-code", "ai-chief-of-staff", "agent-governance"]
---

## "AI Chief of Staff" is already a category — and the best public example is better than people assume

Search for "AI Chief of Staff" today and you'll find a real category, including an official [Anthropic Claude Cookbook example](https://platform.claude.com/cookbook/claude-agent-sdk-01-the-chief-of-staff-agent) that already does more than a lot of writeups give it credit for: it delegates to domain subagents through the Task tool (a `financial-analyst`, a `recruiter`), it uses `CLAUDE.md` as persistent memory across the session, and it has a real gate — Plan Mode, which forces the agent to write a plan to a file for human review before anything executes, backed by `PostToolUse` hooks that audit what actually ran.

That's a solid foundation, and it's scoped to one domain at a time — the Cookbook's example runs a single startup's operations (headcount, runway, hiring). Stretch the same shape across domains that don't share a risk profile in one continuous system — a job offer, a legal contract, an infrastructure incident, all needing the AI's judgment in the same week — and a different set of gaps shows up. None of them are about missing *an* agent or *a* gate. They're about what happens once there's more than one domain and more than one kind of memory competing for the same context window.

I ran into exactly this running a personal Chief of Staff layer on top of Claude Code that manages my technical career transition, finances, legal decisions, and infrastructure work — not one domain, all of them, concurrently. What eventually made it reliable wasn't a bigger model or a longer prompt. It was three structural decisions, each solving a different failure mode:

1. **Domain agents instead of one generalist** — solves context bleed and inconsistent judgment
2. **A hybrid retrieval layer (RAG) instead of "put it all in the prompt"** — solves memory that doesn't scale and doesn't decay
3. **An explicit routing graph instead of prose instructions** — solves the model quietly skipping the step where it should have asked for permission

None of these are novel in isolation — domain subagents and a single approval gate are already in the Cookbook example above. What's missing from most public writeups, that example included, is what happens once you have *multiple* domains and need to decide, edge by edge, which of many possible actions gets to skip confirmation and which doesn't — a permission model that's more granular than one global Plan Mode toggle, and that survives someone editing the workflow six months later without re-reading everything above it.

## How this differs from a single-domain Chief of Staff

| | Claude Cookbook's Chief of Staff | This pattern |
|---|---|---|
| **Scope** | One domain at a time (e.g., a single startup's ops) | Multiple domains concurrently — career, finance, legal, infra, personal |
| **Agent structure** | Subagents via the Task tool, one shared `CLAUDE.md` context | Subagents by domain, plus a triage-only orchestrator that never answers directly itself |
| **Memory** | `CLAUDE.md` as context, read at session start | Two layers: structured memory every domain agent writes back to, plus a separate semantic RAG index over long-form knowledge |
| **Permission model** | Plan Mode — one global gate before any execution | An explicit per-edge graph, deny-by-default, with a lint that blocks a future edit from silently loosening a specific consequential edge |
| **Cross-domain synthesis** | Not applicable — one domain per run | Domains that disagree get synthesized, not averaged — the divergence is the signal |

This isn't "the Cookbook example is wrong" — it's a clean, well-built pattern for its scope. The gaps only matter once a system needs multiple domains with genuinely different risk postures reasoning about the same request, and a permission model granular enough to say yes to routing and no to committing, edge by edge, not domain by domain.

## 1. Domain agents: one "VP" per area, not one mind for everything

Instead of a single system prompt trying to reason about a job offer, a Kubernetes incident, and a legal contract in the same breath, the system is organized like a small org chart. Each life/work domain has a dedicated agent — a "VP" — with a scoped role, its own decision heuristics, and no knowledge of domains outside its lane unless explicitly pulled in.

```
Chief of Staff (routes the request)
├── Tech & Career Lead      → career strategy, market analysis, interview prep
├── Finance Lead            → cash flow, projections, spend approval
├── Legal Lead              → contracts, IP protection, compliance
├── Personal Ops Lead       → energy, burnout signals, life balance
└── Identity & Legacy Lead  → long-term reflection, family history
```

The Chief of Staff's only job is triage: read the request, detect which domain(s) it touches, and either answer directly (for domain-agnostic technical work) or delegate. When a request crosses two domains — say, a job offer that has both a career and a financial dimension — both agents get activated and their outputs get synthesized, rather than one generalist trying to hold both mental models at once.

**Why this matters in practice:** a finance-flavored answer and a career-flavored answer to the same question have genuinely different risk postures. A finance agent should be conservative by default; a career-growth agent should surface upside. Collapsing them into one voice means you get an average of both instincts — which is usually the wrong answer for either.

This is the same idea as microservice boundaries, applied to reasoning: define the interface, let each unit specialize, and pay the coordination cost only when domains actually interact.

## 2. RAG as two layers, not one search index

"RAG" usually means one vector index over one corpus. That's not enough for a system that needs to reason about two very different kinds of knowledge:

- **Structured, queryable memory** — facts, decisions, user preferences that need to be looked up by topic ("what do we know about X"), updated over time, and organized into a taxonomy (I use a wing/room metaphor: broad domain → specific topic)
- **Unstructured personal knowledge** — long-form notes, journal entries, research documents that benefit from semantic similarity search, not exact-match lookup

The system runs both, and treats them differently:

- A **structured memory layer** that the Chief of Staff and every domain agent read from and write to. This is where "the user prefers X," "decision Y was made on date Z because of reason W," and "goal A is in-progress, next step is B" live. It's queried by explicit search calls at the start of a session, and every domain agent is expected to write back what it learned, not just read.
- A **hybrid RAG server over a personal knowledge vault** (embeddings + keyword search combined, served over MCP so any agent in the system can call it as a tool) for the long-form stuff — research notes, journal reflections, project archives. This is where semantic search actually pays off, because you're not looking for an exact fact, you're looking for "what have I already thought about that's similar to this."

The distinction that matters: **structured memory is a write target, not just a read source.** Most RAG writeups treat the knowledge base as static — you index it once, you query it forever. A Chief-of-Staff-style agent needs the inverse property too: every session should be able to leave something behind for the next one. Without that, the system re-derives the same context every time and never actually accumulates judgment.

## 3. The routing graph: making "should I ask first?" a lookup, not a vibe

This is the piece I think is most worth stealing.

Every agent framework eventually runs into the same question: *when does the AI act autonomously, and when does it stop and wait for a human?* The typical answer is prose in a system prompt — "always ask before doing X" — which works until the prompt is long enough that the model treats it as one more paragraph among hundreds, and starts skipping it under pressure to be helpful.

SHU makes this a small, explicit graph instead of a paragraph. `.claude/graph.yaml` encodes the system's real workflows as nodes (agents) and edges (transitions), and every edge carries a `gate`:

```yaml
edges:
  - from: chief-of-staff
    to: delivery-coordinator
    condition: "user says 'build', 'implement', 'create'"
    workflow: software-dev
    gate: none  # safe to proceed autonomously

  - from: delivery-coordinator
    to: implementation-team
    condition: "plan is ready"
    workflow: software-dev
    gate: gerardo-approval-required  # STOP. Ask first.
```

Two rules make this trustworthy instead of decorative:

- **Deny-by-default.** The gate defaults to "ask first" — an edge is only allowed to skip confirmation if it's explicitly marked `gate: none`, and that marking has to trace back to a real, low-risk pattern. A routing edge like the first one above (which agent handles this) is fine as `gate: none` because it doesn't do anything by itself. A consequential edge — commits to a plan, spends money, sends something external — isn't.
- **A validator, not just documentation.** A small script checks the graph for two things: referential integrity (every node an edge points to actually exists), and a lint that hard-codes which edges represent a consequential action and fails if any of those specific edges is marked `gate: none`. That second check is the one that actually matters: it means a future edit that tries to quietly loosen a *consequential* gate gets caught mechanically, not by someone happening to re-read a 2,000-line prompt carefully enough to notice.

The graph doesn't execute anything — it's not an orchestration engine. It's closer to a routing table the agent consults before acting: "given where I am and what the user just asked, what's the next step, and do I need permission?" That question becomes a lookup instead of a judgment call made fresh (and inconsistently) every time.

## What this looks like end-to-end

Take a request that touches two domains at once — a job offer arrives with a salary bump but a demanding relocation clause. Walked through the system:

1. **Triage.** The Chief of Staff reads the request, detects it spans career and finance, and activates both domain agents rather than answering in one generalist voice.
2. **Parallel reasoning.** The career agent evaluates it against market data and growth trajectory. The finance agent runs it against cash flow, runway, and what the relocation costs actually do to the numbers. Each stays in its own lane — the finance agent doesn't get talked into optimism by the career agent's framing, and vice versa.
3. **Synthesis, not a vote.** The two outputs get merged into where they agree and where they genuinely diverge — the divergence is usually the real decision, not a detail to average away.
4. **The gate.** This workflow's graph marks exactly one edge `gate: gerardo-approval-required`: the step where the system would otherwise commit to a recommendation as final. It doesn't. It stops, presents three paths (conservative / balanced / aggressive) with the trade-offs of each, and waits.

Nothing here required the model to "remember" to be careful. The caution is structural — the workflow's edges were authored that way, checked by the validator, and the model is just following the graph like any other lookup.

## What didn't work at first

The deny-by-default rule and the graph's lint check aren't decorative — they exist because the earlier version of this system didn't have them. Before the graph was explicit, "ask before proceeding" was a paragraph in a long prompt, and long prompts get skimmed under pressure to be helpful. A workflow edit could, in principle, loosen a permission gate without anyone noticing, because there was no mechanism checking that edits to a 2,000-line document preserved a rule stated once, 800 lines earlier.

The fix wasn't "write a clearer prompt." It was moving the rule out of prose and into something a script can check: a graph where every edge in a human-decision workflow (a financial commitment, a career decision) is asserted to require approval, and a validator that fails the build if a future edit tries to mark one of those edges `gate: none`. The rule stopped depending on the model — or a future editor — reading carefully enough to notice.

The other early failure was subtler: one system prompt reasoning about career and finance in the same breath didn't produce wrong answers exactly, it produced *averaged* ones — cautious where it should have shown upside, optimistic where it should have flagged risk. Splitting into domain agents didn't fix a correctness bug; it fixed a judgment-blending bug that's much harder to spot in a single transcript, because nothing about the output looks obviously wrong until you compare it against what a domain specialist would have said.

## Why the composition matters more than any single piece

Domain agents without the graph just means multiple voices that can each independently take a risky action — you've distributed the judgment problem, not solved it. A routing graph without domain agents is just a state machine wrapped around one generalist, which doesn't fix the context-bleed problem. RAG without either is a search engine, not a system that acts.

Put together, the shape is: **specialized reasoning, retrieved context that persists and grows, and an explicit, mechanically-checked answer to "am I allowed to do this alone."** That third piece is the one I see missing most often in personal-agent writeups — plenty of people build the first two and then hope the model behaves.

## If you want to build your own version

You don't need this system's specific stack (Claude Code, a particular memory server) to use the pattern. Four steps translate to any agent framework:

1. **Map your actual domains, not generic ones.** List the 3-5 areas where you'd want genuinely different risk postures — not "work vs. personal," but places where a cautious answer and an optimistic answer would both be defensible and you want both instincts represented, not averaged.
2. **Pick one persistent store your agents write to, not just read from.** A RAG index you only query is a search engine. The system needs to leave something behind each session — a decision, a preference, a fact — or it re-derives the same context from zero every time and never accumulates judgment.
3. **Write your workflows down as explicit steps before you write any prompt.** For each one, mark the exact step that must not proceed without your confirmation. Everything else defaults to requiring confirmation too, until you can point to a specific, low-risk reason to mark it otherwise.
4. **Lint the permission graph, don't just write it once.** A five-line script that checks "no edge in a human-decision workflow is marked safe-to-skip" catches the failure mode that actually matters: a future edit that quietly loosens something nobody meant to loosen.

*This describes the architecture pattern, not a specific product — the goal is a reusable structure, not a walkthrough of my particular deployment. If there's interest, a follow-up post could go deeper into the memory taxonomy design or the skill-crystallization loop that decides when a repeated task graduates into a reusable, named capability.*
