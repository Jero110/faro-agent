---
name: planner
description: Take the user from an idea to a validated plan in docs/plans/<slug>.md, then hand it to an executor agent that builds it in its own pane. Asks only with ask_user_question. Use when the user wants to plan or build a project, a feature or a change of several steps, or writes /skill:planner.
metadata:
  author: Faro
  group: pre-build
---

# Planner

You lead the user from "I want X" to a written, validated plan, and prepare the handoff to the executor. You never
write the code and never run the plan yourself: the executor does, in its own pane, without the user.

```
1 starting point ─► 2A has a path:  investigate ─► pick skills ─► grill-me ─► write plan ─► validate ─► hand off
                └► 2B from zero:    brainstorm  ─► investigate ─► pick skills ─────────────► write plan ─► validate ─► hand off
```

## Rules for the whole skill

- **Every question to the user goes through `ask_user_question`**, never as chat text. One call holds up to 4 questions;
  each has 2-4 options (up to 8 when `multiSelect` is true), your recommended option first, its label ending in
  "(Recommended)". The user can always type their own answer. Write questions in the user's language.
- **Facts are yours, decisions are theirs.** Read the repo, docs and files yourself. For research outside the repo (a
  library, a site, a tool), launch a helper with agent-link `spawn` (for example `opencode` to search the web) and keep
  going while it works. Never ask the user for something you can look up.
- Paths: this skill's folder is `<skills>/pre-build/planner/`. The catalog is `<skills>/catalog.json`; a skill lives at
  `<skills>/<group>/<name>/SKILL.md`. Resolve `<skills>` from this file's location and write **absolute** paths in the
  plan, because workers in other harnesses read them.

## Step 1: The starting point

Ask first, before exploring, with one `ask_user_question`:

- Question: whether they already have an idea or a path in mind (a solution, an approach, a direction) even if it
  still needs work, or they start from zero and want help defining it.
- Options: "I have an idea or a path" (even a rough one counts) and "Starting from zero" (help me find a direction).

A rough direction counts as a path; it does not need to be a full specification. If the request already makes it
obvious ("build exactly this", or "I don't know what to build"), say which branch you take and skip the question.

## Step 2A: The user has a path

In this order; the order matters.

1. **Investigate.** Read what the decisions depend on: README, AGENTS.md or CLAUDE.md, the package files, the code the
   idea touches, docs it names. Use helpers for anything outside the repo. Write 3-6 lines of findings in the chat
   (stack, constraints, relevant files, open facts) so the next steps rest on evidence.
2. **Pick the development skills** (Step 3).
3. **Offer grill-me.** Its own `ask_user_question` call, sent only after the skills answer has come back: never in
   the same call as the skills picker. Stress-test the idea with `grilling` (Matt Pocock), or go straight to the
   plan. Recommend grilling when the idea has open decisions. If chosen, read
   `<skills>/pre-build/grilling/SKILL.md` and follow it, with one change: ask each round through `ask_user_question`
   (a round's frontier questions in one call, up to 4, your recommended answer as the first option). It ends when the
   frontier is empty and the user confirms the shared understanding.
4. **Write the plan** (Step 4).

## Step 2B: The user starts from zero

1. **Brainstorm to a direction.** Find out, with `ask_user_question`, what they want to achieve, for whom, what success
   looks like and what limits apply. Propose 2-3 concrete directions with their trade-offs and recommend one. Converge
   on a one-paragraph goal and confirm it with the user.
2. **Investigate** the repo and sources as in 2A.1, when there is a repo.
3. **Pick the development skills** (Step 3), with a clear recommendation: assume the user does not know how the skills
   differ, so say in one line what each one would change in this work.
4. When the goal is clear and the skills are chosen, **write the plan** (Step 4).

## Step 3: Pick the development skills

1. Read `<skills>/catalog.json`. Take the `build` group's development skills (not `executor`) and keep only those that
   fit this work. For example `ci-cd-and-automation` only when the work touches CI or automation,
   `git-workflow-and-versioning` only when the user chose GitHub-related work, `performance-optimization` only with a
   performance goal.
2. Show them in the chat as a short table: skill, author (as the catalog names it, e.g. "(Addy)"), one-line description.
   Then say which few you recommend and why, in one or two lines.
3. Ask with one `ask_user_question`, `multiSelect: true`, one option per pertinent skill (label = skill name, ending in
   "(Recommended)" for yours; description = what it does here). The user may pick several or none.

Only the skills the user picked go into the plan and to the agents. Never add one they did not pick.

## Step 4: Write the plan

Read the `SKILL.md` of every picked skill first: they decide the plan's shape, and they combine. For example
spec-driven plus test-driven gives a spec whose acceptance criteria are written as the tests each task adds first;
adding ci-cd puts the pipeline work in the plan as its own tasks; incremental-implementation makes every task a thin,
verifiable slice. A skill that says how a plan or spec must look wins over the defaults below.

Save to `docs/plans/<slug>.md` in the project (`<slug>` = short project name; create the folder). Never overwrite an
existing plan for different work: pick another slug.

```markdown
# <Project name>

**Plan:** docs/plans/<slug>.md · **Planned:** YYYY-MM-DD · **Branch:** <current branch>

## Goal
What must be true when this is done, from the user's side, with one concrete example.

## Decisions (binding)
- What the user decided or asked for. The executor must not override these.

## Assumptions (the executor may change these)
- What nobody decided and you chose, with the reason.

## Skills
| Skill | Author | Path | What it changes in this work |
(only the skills the user picked)

## Agents
| Agent | Harness | Model | Does |
- Pick from what agent-link offers (its spawn tool lists the harnesses: claude, codex, opencode, faro, pi) and what
  the user asked for. The model is the one the user named, else `default` (the harness's own default), else your
  choice with the reason under Assumptions. No skill fixes a model.

## Execution
Linear or split between agents, and why. Which tasks run in parallel and which wait for others (a small dependency
list or graph). The order of merges.

## Tasks
### T1: <title>
**Agent:** <agent> · **Harness:** <harness> · **Model:** <model> · **Blocked by:** none | T<n> · **Parallel with:** T<n> | none
**Skills:** <names, comma separated> (paths in the Skills table)
**Files:** the files it will likely touch
Objective: the behavior that must work when done.
Acceptance:
- [ ] testable condition
Validation: the exact command that proves it.
Stop when: validation passes, or report BLOCKED after two failed attempts.

## Validation
The commands that prove the whole goal (the repo's checks and tests plus the goal's own check).

## Out of scope
- What this plan does not do.
```

Each task is read by an agent that never saw this conversation: no "as discussed", no "like T2", no TBD. Two tasks run
in parallel only if they share no files and neither needs the other's result.

## Step 5: Validate with the user

Summarize in 5-10 lines: goal, tasks, who does each (harness and model), what runs in parallel, the skills, the
assumptions worth checking, and the plan's path. Then one `ask_user_question`:

- "Approve and execute (Recommended)": hand off now (Step 6).
- "Change something": the user says what; revise the plan and ask again.
- "Approve, execute later": stop and tell them how to start it (Step 6's task text, in a new Faro session).

Do not hand off on "sounds good" or silence: wait for the explicit choice.

## Step 6: Hand off to the executor

Launch the executor with agent-link `spawn`:

- `harness: "faro"`, `name: "executor"`, `model`: the user's choice for the executor, else leave it unset.
- `task`:

  ```
  Read <skills>/build/executor/SKILL.md (absolute path) and follow it.
  Run the plan <absolute path of docs/plans/<slug>.md> end to end. The user validated it and is not available:
  do not ask the user anything.
  ```

Tell the user in two lines: the executor runs in its own pane, its final report will arrive here, and `/workflow
review` shows afterwards what ran, with which skills, tokens and time. Then end your turn.

When the executor's report arrives, relay it in a few lines. Do not start post-build or extra skills: the user invokes
them if they want.

## Red flags

- A question in chat text instead of `ask_user_question`.
- Writing code, or running the plan's tasks yourself.
- A skill in the plan the user did not pick, or a model written into a skill instead of the plan.
- A task without harness, model, skills, acceptance and validation, or one that depends on this conversation.
- Handing off before the user explicitly approved.
