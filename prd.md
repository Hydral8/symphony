# Parallel Worlds for Software — PRD

## 1. Overview

**Parallel Worlds for Software** is a developer tool that allows an AI coding agent (powered by Codex) to automatically create, explore, and evaluate multiple parallel implementations of a task on the same codebase. Instead of iterating serially (write → test → fix), developers can *speculate in parallel*, observe outcomes, and select the best “world” to merge.

The system operates by creating multiple Git branches ("worlds"), each representing a distinct strategy for solving a task. Each world is executed, tested, and recorded, producing artifacts that let developers compare behavior, risk, and results side-by-side.

This unlocks a fundamentally new workflow: **programming by exploration and selection**, rather than manual trial-and-error.

---

## 2. Problem Statement

Modern software development is constrained by serial iteration:

* Developers try one approach at a time
* Alternatives are mentally simulated, not empirically tested
* High-risk changes discourage experimentation

Even with AI-assisted coding, developers are still forced to:

* Choose an approach prematurely
* Manually explore tradeoffs
* Rewrite or discard code repeatedly

**There is no native way to explore multiple valid implementations of the same intent in parallel and compare them empirically.**

---

## 3. Solution

Parallel Worlds introduces a new primitive:

> **Intent → Parallel Implementations → Executed Traces → Selection**

Given a task (e.g. "fix this bug" or "improve endpoint latency"), the agent:

1. Spawns multiple Git branches automatically
2. Implements distinct solution strategies in each branch
3. Executes each branch using a shared harness
4. Records behavior and outcomes
5. Presents results for comparison and selection

The developer chooses the world to keep and merges it.

---

## 4. Key Concepts

### 4.1 Worlds

A **World** is:

* A Git branch
* A full, runnable version of the repo
* A specific strategy chosen by the agent

Each world is isolated, reproducible, and inspectable.

### 4.2 Branchpoints

A **Branchpoint** is a moment where the agent forks execution into parallel worlds.

Branchpoints can be:

* Explicitly requested by the user
* Autonomously initiated by the agent when uncertainty or multiple strategies exist

Developers can:

* Inspect branchpoints
* Add constraints or guidance
* Re-fork from any branchpoint

### 4.3 Execution Traces

Each world produces **Execution Traces**, which may include:

* Test results
* CLI output
* HTTP request/response logs
* Playwright traces or screenshots
* Timing / performance metrics

These traces are first-class artifacts used for comparison.

---

## 5. User Workflow

### Step 1: Provide Intent

User or agent provides a task, e.g.:

* "Fix the failing checkout bug"
* "Reduce latency of /search endpoint"
* "Refactor auth into a separate module"

### Step 2: Parallel Kickoff (Autonomous)

At any point, the agent may initialize the **Parallel Kickoff Tool**, which:

* Creates N branches from the current HEAD
* Assigns a distinct strategy to each branch

This can happen without explicit user instruction.

### Step 3: Implementation

Each branch:

* Uses a separate Codex worktree
* Implements changes independently
* Annotates its approach and assumptions

### Step 4: Execution & Recording

A shared runner:

* Executes the same test or interaction harness on each branch
* Captures execution traces
* Stores results alongside the branch

### Step 5: Visual Comparison

User views:

* Branch graph
* Diffs per world
* Execution traces side-by-side
* Agent-written summaries of differences and risks

### Step 6: Selection & Merge

User selects a world to:

* Merge into main
* Or refine further via new branchpoints

---

## 6. Visual Interface (v1)

### 6.1 Branch Graph View

* Timeline-style graph of branches
* Clearly marked branchpoints
* Ability to select any world

### 6.2 World Comparison Panel

For selected worlds:

* Code diff summary
* Strategy explanation
* Execution trace results

### 6.3 Branchpoint Editing

At any branchpoint, user can:

* Add constraints ("must keep API stable")
* Request new parallel forks
* Kill unpromising worlds

---

## 7. Agent Architecture

### Planner Agent

* Interprets intent
* Decides whether to spawn parallel worlds
* Chooses number of branches and strategies

### Implementer Agents (N)

* One per world
* Operate in isolated worktrees
* Implement code changes

### Runner Agent

* Executes builds/tests
* Captures traces
* Normalizes outputs for comparison

### Summarizer Agent

* Explains differences between worlds
* Highlights tradeoffs and risks

---

## 8. Autonomy Model

The agent may autonomously trigger Parallel Kickoff when:

* Multiple plausible strategies exist
* Confidence is low
* Risk is high
* Performance tradeoffs are unclear

This autonomy is bounded by:

* Repo-scoped permissions
* Visible branch creation
* Human-in-the-loop selection

---

## 9. Non-Goals (v1)

* Cloud-scale deployments
* Kubernetes or production infra
* Arbitrary language support
* Full IDE integration
* Non-code domains

---

## 10. Open Source Strategy

* Entire system is open source
* MIT or Apache-2.0 license
* Demo repo included
* Clear agent logs for auditability

---

## 11. Hackathon Demo Plan

**Demo scenario:**

* Existing repo with a failing test or performance issue
* Agent initiates parallel kickoff
* 3 branches appear
* Each branch runs
* Execution traces displayed
* Developer selects best world and merges

Total demo time: ~3 minutes

---

## 12. Why This Matters

Parallel Worlds transforms software development from a linear activity into an exploratory one.

It enables:

* Faster convergence on good solutions
* Reduced fear of experimentation
* Empirical comparison of design choices

This is a new programming primitive, not just a faster editor.
