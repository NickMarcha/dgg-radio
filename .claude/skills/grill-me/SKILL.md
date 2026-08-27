---
name: grill-me
description: Relentlessly interview the user about a plan, decision, or design until every branch of the design tree is resolved. Use when the user asks to be grilled or wants to stress-test their thinking.
disable-model-invocation: true
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment, use the available filesystem and tools to find it. If delegated or background work is available and authorized, it may be used for independent fact-finding. Don't block the rest of the frontier on it: only questions downstream of the unsettled fact should wait.

The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree has been visited and nothing remains silently assumed. Do not act on the plan or design until the user confirms you have reached a shared understanding.
