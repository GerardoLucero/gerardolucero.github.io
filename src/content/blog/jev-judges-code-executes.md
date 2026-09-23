---
title: "Jev Judges, Code Executes"
description: "A month after arguing for cells over harnesses, the trading industry got to nearly the same design by a completely different road — economics instead of biology."
pubDate: 2026-09-22
draft: false
tags: ["ai-agents", "architecture", "evolutionary-computation", "system-one-models"]
---

Four weeks ago I wrote about why I think the dominant way we're building AI agents right now — one model, growing a chest of tools and memory and sub-agents, designed top-down like an org chart with a chief of staff at the top — [is the wrong shape](/blog/cells-not-chiefs-of-staff). I argued for something closer to Tierra or Avida: a population of minimal agents (observe, act, mutate, replicate, die, signal), where complexity emerges from selection pressure rather than being drafted top-down. The one non-negotiable was that fitness has to be verified externally — a cell that grades its own homework will lie to you, whether or not it means to.

I didn't expect a follow-up this soon, and I definitely didn't expect the evidence to come from crypto trading bots.

## A different road to the same intersection

Nobody building this stuff was reading my blog. They got here because full-reasoning LLMs are too slow and too expensive to sit in a hot path. That's the whole motivation. But the shape they landed on is, structurally, close to what I was arguing for — arrived at from economics instead of biology.

The clearest expression is [Jev](https://www.eigent.ai/es/blog/typesafe-ai-jev-system-one-models), from TypeSafe AI, a "System One Model." Instead of generating text, it evaluates a small set of predefined questions against whatever state you hand it and returns typed, probabilistic judgments: `Noul` (yes/no with a calibrated probability), `Choice` (a full probability distribution over options), `Score` (a position on an ordinal scale). None of it is free text. Paraphrasing rather than quoting: the code is supposed to own control flow and side effects; the model supplies narrow, bounded judgments into that structure, and hard cases escalate to full reasoning instead of stretching the small model.

That's the cell.

## The catalog that convinced me

[A gist cataloging](https://gist.github.com/drillan/6916b16e8ea31a8ec36c8f59d6483150) over a dozen financial and trading projects on top of Jev converges on nearly the same pattern: a feature engine compresses state to under 400 tokens, one Jev call returns a handful of atomic judgments, those feed a rule-based policy engine, and — critically — a layer of hard-coded risk vetoes sits on top of all of it. Loss halts, allocation caps. The model's opinion cannot override them, no matter how confident it is.

The phrase from that catalog I keep coming back to is simpler than any of my Tierra analogies: *Jev judges, code executes.* That's the fitness function being externally verified with real money on the line. If Jev says "buy" at 0.91 confidence and the veto layer says the position cap is hit, the veto wins — no negotiation. That's the same failure mode I raised in the original post, the run that learned to delete the file it was graded against: you can't let the thing being evaluated also be the referee. Trading firms didn't get here from reading about mesa-optimization. They got here because the first time a model was wrong with real capital behind it, the fix had to be structural.

Another writeup put the interface as cleanly as I've seen it stated anywhere: [state in, typed probabilistic decisions out](https://gist.github.com/pjburnhill/adf8d28efcad9df037bfdece178ef965). Nothing about the model choosing what happens next. The code already knows the workflow; the model just answers the question it was asked.

## It's already commoditizing

There's already an open-source family, [Kev](https://github.com/jaredpalmer/kev) — a LoRA and pointer-head over a frozen Qwen3.5 base, shipped at 0.8B/4B/9B, meant to be trained and run yourself rather than rented. And [as of yesterday](https://bugtraqsolutions.com/noticias/2026-09-21-laya-vs-jev-modelos-system-one), a 421M-parameter competitor called Laya showed up claiming roughly 8x the throughput of Jev on comparable tasks — I've only seen the headline on that one, not the underlying numbers, so I'm holding it loosely.

None of these projects call what they built a "cell." Strip the branding and you get: a minimal unit that observes a narrow slice of state, emits one typed judgment, and hands control back to something checkable. General intelligence and fast cheap judgment kept in two separate, auditable boxes — because fusing them into one model that reasons about everything was worse at the one thing that matters in a trading system: not being wrong in a way nobody catches.

I still don't think I was first to this idea, and I said so a month ago. I'm more convinced than I was, mostly because the people arriving at it had no reason to care about my framing and landed there anyway. But this is still a hypothesis I'm testing against evidence I didn't generate, not something I've built or verified end to end myself. If I get around to the small version — applying this inside my own system instead of just writing about other people's — that's the next post.
